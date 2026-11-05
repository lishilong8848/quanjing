import { parsePurchaseReceiptImageMessage } from './purchase-receipt-image-message';
import { createLifecycleReceiptImageVerifier, type VerifiedLifecycleReceiptImageSnapshot } from './purchase-lifecycle-receipt-image-binding';

type MessageReadback = { messageId: string; chatId: string; senderOpenId: string; messageType: string; imageKey: string; createdAtMs: number; deleted: boolean };
export interface PurchaseLifecycleReceiptEventTransport {
  /** True only for an event delivered by the authenticated Feishu connection for this app. */
  verifyEventOrigin(payload: unknown, expectedAppId: string): Promise<boolean>;
  /** Authenticated Feishu GET; implementation verifies API code and returns one unique message. */
  readImageMessage(messageId: string, expectedAppId: string): Promise<MessageReadback>;
}
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : null; }

/** Runs network and event authentication outside the purchase ledger lock. */
export function createPurchaseLifecycleReceiptEventVerifier(transport: PurchaseLifecycleReceiptEventTransport) {
  return {
    async verify(payload: unknown, expectedAppId: string): Promise<VerifiedLifecycleReceiptImageSnapshot> {
      if (!/^cli_[A-Za-z0-9_-]+$/.test(expectedAppId) || await transport.verifyEventOrigin(payload, expectedAppId) !== true) throw new Error('签收图片事件来源未认证');
      const event = parsePurchaseReceiptImageMessage(payload);
      if (!event) throw new Error('签收图片事件无效');
      const root = object(payload), header = object(root?.header), body = object(root?.event) || root;
      const sender = object(body?.sender), message = object(body?.message);
      const reportedApp = header?.app_id ?? root?.app_id;
      if (reportedApp !== undefined && reportedApp !== expectedAppId) throw new Error('签收图片应用身份不匹配');
      if (sender?.sender_type !== 'user' || message?.chat_type !== 'p2p' || message?.message_type !== 'image') throw new Error('签收图片会话不匹配');
      const verified = await transport.readImageMessage(event.messageId, expectedAppId);
      if (!verified || verified.deleted !== false || verified.messageId !== event.messageId || verified.chatId !== event.chatId ||
          verified.senderOpenId !== event.actorOpenId || verified.messageType !== 'image' || verified.imageKey !== event.imageKey ||
          !Number.isSafeInteger(verified.createdAtMs) || verified.createdAtMs < 1_000_000_000_000) throw new Error('签收图片回读不一致');
      const verifier = createLifecycleReceiptImageVerifier(async () => ({ appId: expectedAppId, eventId:event.eventId, actorOpenId:event.actorOpenId,
        chatId:event.chatId, imageMessageId:event.messageId, imageKey:event.imageKey, messageCreatedAtMs:verified.createdAtMs,
        senderType:'user', chatType:'p2p', messageType:'image' }));
      return verifier.verify(payload, expectedAppId);
    },
  };
}
