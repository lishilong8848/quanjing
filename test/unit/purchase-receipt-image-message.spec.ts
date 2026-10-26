import { parsePurchaseReceiptImageMessage } from '../../server/modules/purchase-inventory/purchase-receipt-image-message';

describe('purchase receipt image message', () => {
  it('parses a direct image message from the requester', () => {
    expect(
      parsePurchaseReceiptImageMessage({
        schema: '2.0',
        event_type: 'im.message.receive_v1',
        event_id: 'evt_image_01',
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'ou_requester' },
        },
        message: {
          message_id: 'om_image_01',
          chat_id: 'oc_direct_01',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_v3_01' }),
        },
      }),
    ).toEqual({
      eventId: 'evt_image_01',
      actorOpenId: 'ou_requester',
      messageId: 'om_image_01',
      chatId: 'oc_direct_01',
      imageKey: 'img_v3_01',
    });
  });

  it('ignores group and non-image messages', () => {
    expect(
      parsePurchaseReceiptImageMessage({
        schema: '2.0',
        event_type: 'im.message.receive_v1',
        event_id: 'evt_text_01',
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'ou_requester' },
        },
        message: {
          message_id: 'om_text_01',
          chat_id: 'oc_direct_01',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      }),
    ).toBeNull();
  });
});
