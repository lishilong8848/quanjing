import { buildLifecycleReceiptPreparationFeedback, buildLifecycleReceiptUploadButtons, buildPurchaseLifecycleForm, parsePurchaseLifecycleFormAction, parsePurchaseLifecycleFormSubmitName, purchaseLifecycleFormSubmitName, type PurchaseLifecycleFormBinding } from '../../server/modules/purchase-inventory/purchase-lifecycle-form';
import { purchaseBatchReceiptFieldName } from '../../server/modules/purchase-inventory/purchase-batch-fulfillment-card';
import { randomBytes, randomUUID } from 'node:crypto';

const base: PurchaseLifecycleFormBinding = { action: 'submit_order', role: 'purchaser', approvalBatchId: 'purchase-application-12345678', executionRecordId: 'rec12345678', flowVersion: 'lifecycle_v1', cardRevision: 3 };
const token = randomBytes(32).toString('base64url');
function action(binding: PurchaseLifecycleFormBinding, form_value: unknown) {
  return { tag: 'button', name: purchaseLifecycleFormSubmitName(token), form_value };
}
function parse(binding: PurchaseLifecycleFormBinding, formValue: unknown) {
  return parsePurchaseLifecycleFormAction(action(binding, formValue), { token, binding });
}

describe('purchase lifecycle forms', () => {
  it('binds the record, role, revision and flow to a bounded canonical form name', () => {
    const name = purchaseLifecycleFormSubmitName(token);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(parsePurchaseLifecycleFormSubmitName(name)).toEqual(token);
    expect(parsePurchaseLifecycleFormSubmitName('old-name')).toBeNull();
    expect(() => parsePurchaseLifecycleFormSubmitName(name + 'x')).toThrow();
    expect(() => buildPurchaseLifecycleForm({ binding: { ...base, role: 'manager' }, token })).toThrow();
    expect(() => buildPurchaseLifecycleForm({ binding: { ...base, cardRevision: 0 }, token })).toThrow();
  });

  it('renders actual order fields and strictly parses them without permitting injected authorization fields', () => {
    const form = buildPurchaseLifecycleForm({ binding: base, token });
    expect(form.tag).toBe('form');
    expect(JSON.stringify(form)).toContain('actual_quantity');
    const values = { actual_quantity: '3', actual_amount: '838.35', order_note: '' };
    expect(parse(base, values)).toMatchObject({ ...base, actualQuantity: 3, actualAmount: 838.35, note: '' });
    expect(() => parse(base, { ...values, role: 'manager' })).toThrow();
    expect(() => parse(base, { ...values, actual_quantity: '' })).toThrow();
    expect(() => parse(base, { ...values, actual_amount: -1 })).toThrow();
    expect(() => parsePurchaseLifecycleFormAction(action(base, values), { token: randomBytes(32).toString('base64url'), binding: base })).toThrow();
  });

  it('parses a single item rejection and rejects unknown or blank fields', () => {
    const binding: PurchaseLifecycleFormBinding = { ...base, action: 'submit_item_reject', role: 'manager' };
    expect(parse(binding, { rejection_reason: ' 不符合要求 ' })).toMatchObject({ ...binding, rejectionReason: '不符合要求' });
    expect(() => parse(binding, { rejection_reason: ' ' })).toThrow();
    expect(() => parse(binding, { rejection_reason: '原因', approvalBatchId: 'other' })).toThrow();
  });

  it('uses per-record receipt fields and preserves the photo/invoice prerequisites', () => {
    const binding: PurchaseLifecycleFormBinding = { ...base, action: 'submit_receipt', role: 'requester' };
    const options = { binding, token, signerOpenId: 'ou_12345', purchaseMethod: '自采', receiptPhotoCount: 1, invoiceCount: 0 };
    const form = buildPurchaseLifecycleForm(options);
    expect(JSON.stringify(form)).toContain('"disabled":true');
    expect(JSON.stringify(buildPurchaseLifecycleForm({ ...options, invoiceCount: 1 }))).toContain('"disabled":false');
    const field = (name: 'signer_open_id' | 'receipt_time' | 'receipt_note') => purchaseBatchReceiptFieldName(name, binding.executionRecordId);
    const values = { [field('signer_open_id')]: 'ou_12345', [field('receipt_time')]: '2026-11-04 12:00', [field('receipt_note')]: '收到' };
    expect(parse(binding, values)).toMatchObject({ ...binding, signerOpenId: 'ou_12345', note: '收到' });
    expect(() => parse(binding, { ...values, signer_open_id: 'ou_other' })).toThrow();
  });

  it('hides upload actions until trusted readiness and binds them to this authorized receipt and revision', () => {
    const binding: PurchaseLifecycleFormBinding = { ...base, action:'submit_receipt', role:'requester' };
    expect(buildLifecycleReceiptUploadButtons(binding,'需求自采',false)).toEqual([]);
    const buttons=buildLifecycleReceiptUploadButtons(binding,'需求自采',true);
    const values=buttons.map(button => (button.behaviors as any[])[0].value);
    expect(values.map(value=>value.action)).toEqual(['prepare_receipt_photo','prepare_invoice']);
    for (const value of values) expect(value).toMatchObject({version:4,flowVersion:'lifecycle_v1',role:'requester',approvalBatchId:binding.approvalBatchId,executionRecordId:binding.executionRecordId,cardRevision:3});
    expect(buildLifecycleReceiptUploadButtons(binding,'综合采购',true)).toHaveLength(1);
    expect(() => buildLifecycleReceiptUploadButtons(base,'需求自采',true)).toThrow();
  });
  it('never renders expired or another person/card receipt readiness',()=>{
    const expected={recordId:'rec123',recipientOpenId:'ou_person',messageId:'om_card',nowMs:1000};
    const ready={taskId:'task_1',executionRecordId:'rec123',recipientOpenId:'ou_person',cardMessageId:'om_card',materialType:'invoice' as const,state:'ready' as const,intentId:'intent_1',intentExpiresAtMs:1001};
    expect(JSON.stringify(buildLifecycleReceiptPreparationFeedback(ready,expected))).toContain('请在当前私聊发送发票图片');
    expect(JSON.stringify(buildLifecycleReceiptPreparationFeedback({...ready,intentExpiresAtMs:1000},expected))).not.toContain('请在当前私聊发送');
    expect(()=>buildLifecycleReceiptPreparationFeedback({...ready,recipientOpenId:'ou_other'},expected)).toThrow();
    expect(()=>buildLifecycleReceiptPreparationFeedback({...ready,cardMessageId:'om_old'},expected)).toThrow();
  });

  it('rejects oversized or malformed names, non-buttons and wrong action fields', () => {
    expect(() => parsePurchaseLifecycleFormSubmitName('lcf1:' + 'x'.repeat(101))).toThrow();
    expect(() => parsePurchaseLifecycleFormAction({ ...action(base, {}), tag: 'select_person' }, { token, binding: base })).toThrow();
    expect(() => parse(base, { rejection_reason: '不允许' })).toThrow();
    expect(() => buildPurchaseLifecycleForm({ binding: { ...base, approvalBatchId: 'x'.repeat(161) }, token })).toThrow();
  });

  it('keeps the name bounded even for realistic and maximum length identifiers', () => {
    const typical = { ...base, approvalBatchId: `purchase-application-${randomUUID()}`, executionRecordId: 'rec123456789012', cardRevision: 123456 };
    const maximum = { ...base, approvalBatchId: 'A'.repeat(160), executionRecordId: 'r'.repeat(100), cardRevision: Number.MAX_SAFE_INTEGER };
    for (const binding of [typical, maximum]) {
      const form = buildPurchaseLifecycleForm({ binding, token });
      const button = (form.elements as Array<Record<string, unknown>>).at(-1)!;
      expect(String(button.name)).toHaveLength(48);
      expect(parse(binding, { actual_quantity: '1', actual_amount: '0', order_note: '' })).toMatchObject(binding);
    }
  });
});
