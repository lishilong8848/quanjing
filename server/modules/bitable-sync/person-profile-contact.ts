const FEISHU_OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{8,128}$/;
const FEISHU_CHAT_APPLINK = 'https://applink.feishu.cn/client/chat/open';
const PERSON_FIELD_IDENTIFIER_KEYS = [
  'id',
  'open_id',
  'openId',
  'user_id',
] as const;

export function extractFeishuOpenId(value: unknown): string | null {
  const queue: unknown[] = [value];
  const visited = new Set<object>();

  while (queue.length > 0 && visited.size < 128) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const object = current as Record<string, unknown>;
    for (const key of PERSON_FIELD_IDENTIFIER_KEYS) {
      const candidate = object[key];
      if (
        typeof candidate === 'string' &&
        FEISHU_OPEN_ID_PATTERN.test(candidate.trim())
      ) {
        return candidate.trim();
      }
    }
    queue.push(...Object.values(object));
  }

  return null;
}

export function buildFeishuChatAppLink(openId: unknown): string | null {
  const normalized = typeof openId === 'string' ? openId.trim() : '';
  if (!FEISHU_OPEN_ID_PATTERN.test(normalized)) {
    return null;
  }

  const url = new URL(FEISHU_CHAT_APPLINK);
  url.searchParams.set('openId', normalized);
  return url.toString();
}
