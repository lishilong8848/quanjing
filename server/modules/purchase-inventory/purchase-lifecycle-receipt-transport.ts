import type { PurchaseLifecycleReceiptEventTransport } from './purchase-lifecycle-receipt-event-verifier';

type AuthenticatedHttpGet = (url: string, config: { headers: { Authorization: string }; timeout: number; maxRedirects: number }) => Promise<{ data: unknown }>;
function object(value: unknown): Record<string,unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : null; }
/** A dedicated app-authenticated readback port. Caller supplies a verifier restricted to the trusted WS transport. */
export function createPurchaseLifecycleReceiptTransport(input: {
  configuredAppId(): string;
  verifyEventOrigin(payload: unknown, appId: string): Promise<boolean>;
  appAccessToken(appId: string): Promise<string>;
  get: AuthenticatedHttpGet;
}): PurchaseLifecycleReceiptEventTransport {
  return {
    async verifyEventOrigin(payload, expectedAppId) {
      return /^cli_[A-Za-z0-9_-]+$/.test(expectedAppId) && input.configuredAppId() === expectedAppId && await input.verifyEventOrigin(payload, expectedAppId) === true;
    },
    async readImageMessage(messageId, expectedAppId) {
      if (!/^om_[A-Za-z0-9_-]+$/.test(messageId) || !/^cli_[A-Za-z0-9_-]+$/.test(expectedAppId) || input.configuredAppId() !== expectedAppId) throw new Error('签收图片回读应用或消息无效');
      const token = await input.appAccessToken(expectedAppId);
      if (!token || input.configuredAppId() !== expectedAppId) throw new Error('签收图片回读凭据不可用');
      const response = await input.get(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}?user_id_type=open_id`, { headers:{Authorization:`Bearer ${token}`},timeout:15000,maxRedirects:0 });
      const body = object(response?.data), data = object(body?.data), items = data?.items;
      if (body?.code !== 0 || !Array.isArray(items)) throw new Error('签收图片回读失败');
      const matches = items.filter(item => object(item)?.message_id === messageId);
      const message = matches.length === 1 ? object(matches[0]) : null, sender = object(message?.sender), messageBody = object(message?.body);
      let content: Record<string,unknown> | null = null;
      try { content = typeof messageBody?.content === 'string' ? object(JSON.parse(messageBody.content)) : null; } catch { /* invalid content is rejected below */ }
      const createdAtMs = typeof message?.create_time === 'string' && /^\d{13}$/.test(message.create_time) ? Number(message.create_time) : NaN;
      if (!message || message.deleted !== false || message.msg_type !== 'image' || typeof message.chat_id !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(message.chat_id) ||
          !sender || sender.sender_type !== 'user' || sender.id_type !== 'open_id' || typeof sender.id !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(sender.id) ||
          !content || typeof content.image_key !== 'string' || !/^img_[A-Za-z0-9_-]+$/.test(content.image_key) || !Number.isSafeInteger(createdAtMs)) throw new Error('签收图片回读身份不完整');
      return { messageId, chatId:message.chat_id, senderOpenId:sender.id, messageType:'image', imageKey:content.image_key, createdAtMs, deleted:false };
    },
  };
}
