import { createCipheriv, createHash } from 'node:crypto';
import { parsePurchaseCardCallback, parsePurchaseLongConnectionCardAction } from '../../server/modules/purchase-inventory/purchase-workflow-callback';

const config = { verificationToken: 'test-token', encryptKey: '', legacyApproverOpenIds: [], managerApproverOpenId: 'ou_manager', authorizeFromDeliverySnapshot: true };
const actionValue = (action: string, lifecycle = true) => ({ version: 4, workflowType: 'purchase_batch_fulfillment', role: 'requester', action, approvalBatchId: 'purchase-application-123', executionRecordId: 'rec_item', ...(lifecycle ? { flowVersion: 'lifecycle_v1', cardRevision: 12 } : {}) });
const wsEvent = (action: string, context: Record<string, unknown> = { open_message_id: 'om_message', open_chat_id: 'oc_private' }, lifecycle = true) => ({ schema: '2.0', event_type: 'card.action.trigger', operator: { open_id: 'ou_requester' }, context, action: { tag: 'button', value: actionValue(action, lifecycle) } });

function signedHttp(action: string, context: Record<string, unknown>, tamper = false) {
  const timestamp = '1790000000';
  const nonce = 'test-nonce';
  const encryptKey = 'synthetic-test-key';
  const flattened = wsEvent(action, context);
  const payload = { schema: '2.0', header: { event_id: 'event-1', event_type: 'card.action.trigger', token: config.verificationToken }, event: { operator: flattened.operator, context: flattened.context, action: flattened.action } };
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = Buffer.alloc(16, 3);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const rawBody = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64') });
  const signature = createHash('sha256').update(timestamp).update(nonce).update(encryptKey).update(rawBody).digest('hex');
  return () => parsePurchaseCardCallback({ headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': tamper ? '0'.repeat(64) : signature }, rawBody, now: Number(timestamp) * 1000 }, { ...config, encryptKey });
}

describe('trusted lifecycle receipt chat context', () => {
  it.each(['prepare_receipt_photo', 'prepare_invoice'])('binds %s to the signed HTTP context', action => {
    expect(signedHttp(action, { open_message_id: 'om_message', open_chat_id: 'oc_private' })()).toMatchObject({ authenticatedChatId: 'oc_private', operatorOpenId: 'ou_requester', messageId: 'om_message' });
    expect(signedHttp(action, { open_message_id: 'om_message', open_chat_id: 'oc_private' }, true)).toThrow();
    expect(signedHttp(action, { open_message_id: 'om_message' })).toThrow();
  });
  it.each(['prepare_receipt_photo', 'prepare_invoice'])('requires valid server-supplied context for WS %s', action => {
    const valid = parsePurchaseLongConnectionCardAction(wsEvent(action), config);
    expect(valid).toMatchObject({ authenticatedChatId: 'oc_private' });
    expect(parsePurchaseLongConnectionCardAction(wsEvent(action, { open_message_id: 'om_message', open_chat_id: 'oc_other' }), config).eventId).not.toBe(valid.eventId);
    for (const context of [{ open_message_id: 'om_message' }, { open_message_id: 'om_message', open_chat_id: 'invalid' }, { open_message_id: 'invalid', open_chat_id: 'oc_private' }]) expect(() => parsePurchaseLongConnectionCardAction(wsEvent(action, context), config)).toThrow();
    expect(() => parsePurchaseLongConnectionCardAction({ ...wsEvent(action), operator: { open_id: 'fake' } }, config)).toThrow();
    const forged = wsEvent(action, { open_message_id: 'om_message' });
    (forged.action.value as Record<string, unknown>).open_chat_id = 'oc_forged';
    expect(() => parsePurchaseLongConnectionCardAction(forged, config)).toThrow();
  });
  it('rejects token-only HTTP for new intents while preserving older cards and unrelated actions', () => {
    const e = wsEvent('prepare_receipt_photo');
    const payload = { schema: '2.0', header: { event_id: 'event-1', event_type: 'card.action.trigger', token: config.verificationToken }, event: { operator: e.operator, context: e.context, action: e.action } };
    expect(() => parsePurchaseCardCallback({ headers: {}, rawBody: JSON.stringify(payload) }, config)).toThrow();
    expect(parsePurchaseLongConnectionCardAction(wsEvent('prepare_receipt_photo', { open_message_id: 'om_message' }, false), config)).not.toHaveProperty('authenticatedChatId');
    const order = wsEvent('open_order', { open_message_id: 'om_message' });
    order.action.value.role = 'purchaser';
    expect(parsePurchaseLongConnectionCardAction(order, config)).not.toHaveProperty('authenticatedChatId');
  });
});
