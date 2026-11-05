/** Isolated guard: the injected transport must authenticate each read as the supplied app.
 * It is deliberately not registered with the application. No API capability is assumed.
 */
export interface LifecyclePrivateChatTransport {
  currentAppId(): string;
  readCard(appId: string, messageId: string): Promise<unknown>;
  readChat(appId: string, chatId: string): Promise<unknown>;
  readMembers(appId: string, chatId: string, pageToken?: string): Promise<unknown>;
}

export type LifecyclePrivateChatIdentity = Readonly<{
  appId: string; actorOpenId: string; cardMessageId: string; chatId: string;
}>;
export type LifecyclePrivateChatProof = Readonly<LifecyclePrivateChatIdentity & {
  verifiedAtMs: number; validUntilMs: number;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function dataOf(response: unknown): Record<string, unknown> {
  const envelope = record(response);
  const data = record(envelope?.data);
  if (envelope?.code !== 0 || !data) throw new Error('无法验证私聊身份');
  return data;
}
function validateIdentity(identity: LifecyclePrivateChatIdentity): void {
  if (!/^cli_[A-Za-z0-9_-]+$/.test(identity.appId) || !/^ou_[A-Za-z0-9_-]+$/.test(identity.actorOpenId) ||
      !/^om_[A-Za-z0-9_-]+$/.test(identity.cardMessageId) || !/^oc_[A-Za-z0-9_-]+$/.test(identity.chatId)) {
    throw new Error('无法验证私聊身份');
  }
}

/** Network reads happen before acquiring the workflow ledger lock. The caller must
 * supply identities from trusted event/ledger state and an app-bound transport.
 * `assertProof` is synchronous and must run under that lock immediately before use.
 */
export function createLifecyclePrivateChatVerifier(transport: LifecyclePrivateChatTransport, clock = Date.now) {
  const issued = new WeakSet<object>();
  const requireApp = (appId: string) => {
    if (transport.currentAppId() !== appId) throw new Error('无法验证私聊身份');
  };
  return {
    async verify(identity: LifecyclePrivateChatIdentity): Promise<LifecyclePrivateChatProof> {
      // Capture values now; a caller cannot mutate identity during an async read.
      const bound = { appId: identity.appId, actorOpenId: identity.actorOpenId, cardMessageId: identity.cardMessageId, chatId: identity.chatId };
      validateIdentity(bound);
      requireApp(bound.appId);
      const started = clock();
      if (!Number.isSafeInteger(started) || started < 1) throw new Error('无法验证私聊身份');
      const card = dataOf(await transport.readCard(bound.appId, bound.cardMessageId));
      requireApp(bound.appId);
      if (!Array.isArray(card.items) || card.items.length !== 1) throw new Error('无法验证私聊身份');
      const message = record(card.items[0]), sender = record(message?.sender);
      if (message?.message_id !== bound.cardMessageId || message.chat_id !== bound.chatId ||
          message.msg_type !== 'interactive' || message.deleted !== false || sender?.id !== bound.appId ||
          sender.id_type !== 'app_id' || sender.sender_type !== 'app') throw new Error('无法验证私聊身份');
      const chat = dataOf(await transport.readChat(bound.appId, bound.chatId));
      requireApp(bound.appId);
      if (chat.chat_mode !== 'p2p' || (chat.chat_id !== undefined && chat.chat_id !== bound.chatId)) throw new Error('无法验证私聊身份');
      let pageToken: string | undefined;
      const seen = new Set<string>();
      let members = 0;
      for (let page = 0; page < 10; page++) {
        const response = dataOf(await transport.readMembers(bound.appId, bound.chatId, pageToken));
        requireApp(bound.appId);
        // Require an explicit unfiltered result. Omitted fields, restricted visibility,
        // unsupported p2p member reads, and partial pagination all fail closed.
        if (response.trigger_security_conf_limit !== false || !Array.isArray(response.items) || typeof response.has_more !== 'boolean') throw new Error('无法验证私聊身份');
        for (const item of response.items) {
          const member = record(item);
          if (member?.member_id_type !== 'open_id' || member.member_id !== bound.actorOpenId || ++members > 1) throw new Error('无法验证私聊身份');
        }
        if (!response.has_more) {
          if (members !== 1) throw new Error('无法验证私聊身份');
          const now = clock();
          // Count the whole verification in the freshness window, including slow reads.
          if (!Number.isSafeInteger(now) || now < started || now - started > 30_000) throw new Error('无法验证私聊身份');
          const proof = Object.freeze({ ...bound, verifiedAtMs: now, validUntilMs: now + 30_000 });
          issued.add(proof);
          return proof;
        }
        if (typeof response.page_token !== 'string' || !response.page_token || seen.has(response.page_token)) throw new Error('无法验证私聊身份');
        seen.add(response.page_token);
        pageToken = response.page_token;
      }
      throw new Error('无法验证私聊身份');
    },
    assertProof(proof: LifecyclePrivateChatProof, expected: LifecyclePrivateChatIdentity): void {
      validateIdentity(expected);
      const now = clock();
      if (!proof || !issued.has(proof) || transport.currentAppId() !== expected.appId ||
          proof.appId !== expected.appId || proof.actorOpenId !== expected.actorOpenId ||
          proof.cardMessageId !== expected.cardMessageId || proof.chatId !== expected.chatId ||
          !Number.isSafeInteger(now) || now < proof.verifiedAtMs || now > proof.validUntilMs) throw new Error('无法验证私聊身份');
    },
  };
}
