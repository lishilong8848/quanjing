import { BadRequestException } from '@nestjs/common';

export interface PurchaseReceiptImageMessage {
  eventId: string;
  actorOpenId: string;
  messageId: string;
  chatId: string;
  imageKey: string;
}

export function parsePurchaseReceiptImageMessage(
  payload: unknown,
): PurchaseReceiptImageMessage | null {
  const root = objectValue(payload);
  if (!root) return null;
  const header = objectValue(root.header);
  const eventType =
    stringValue(root.event_type) || stringValue(header?.event_type);
  if (eventType !== 'im.message.receive_v1') return null;

  const event = objectValue(root.event) || root;
  const sender = objectValue(event.sender);
  const senderId = objectValue(sender?.sender_id);
  const message = objectValue(event.message);
  if (
    stringValue(sender?.sender_type) !== 'user' ||
    stringValue(message?.chat_type) !== 'p2p' ||
    stringValue(message?.message_type) !== 'image'
  ) {
    return null;
  }

  const eventId = requiredIdentifier(
    stringValue(root.event_id) || stringValue(header?.event_id),
    '飞书图片消息事件标识无效',
  );
  const actorOpenId = requiredIdentifier(
    stringValue(senderId?.open_id),
    '飞书图片消息发送人无效',
  );
  const messageId = requiredIdentifier(
    stringValue(message?.message_id),
    '飞书图片消息标识无效',
  );
  const chatId = requiredIdentifier(
    stringValue(message?.chat_id),
    '飞书图片消息会话无效',
  );
  const content = parseContent(message?.content);
  const imageKey = requiredIdentifier(
    stringValue(content.image_key),
    '飞书图片资源标识无效',
  );

  return { eventId, actorOpenId, messageId, chatId, imageKey };
}

function parseContent(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new BadRequestException('飞书图片消息内容无效');
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return objectValue(parsed) || invalidContent();
  } catch {
    throw new BadRequestException('飞书图片消息内容无效');
  }
}

function invalidContent(): never {
  throw new BadRequestException('飞书图片消息内容无效');
}

function requiredIdentifier(value: string, message: string): string {
  if (!/^[A-Za-z0-9_:-]{1,256}$/u.test(value)) {
    throw new BadRequestException(message);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
