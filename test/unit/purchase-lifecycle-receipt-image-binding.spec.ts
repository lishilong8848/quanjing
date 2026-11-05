import { createLifecycleReceiptImageVerifier, extractVerifiedLifecycleReceiptImage, matchVerifiedLifecycleReceiptImage, type LifecycleReceiptImageIntent, type VerifiedLifecycleReceiptImage, type VerifiedLifecycleReceiptImageSnapshot } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-binding';

const now = 1_800_000_000_000;
const event: VerifiedLifecycleReceiptImage = { appId: 'cli_test', eventId: 'evt_one', actorOpenId: 'ou_user', chatId: 'oc_private', imageMessageId: 'om_photo', imageKey: 'img_image', messageCreatedAtMs: now - 1000, senderType: 'user', chatType: 'p2p', messageType: 'image' };
const intent: LifecycleReceiptImageIntent = { id: 'intent_1234567890', appId: event.appId, actorOpenId: event.actorOpenId, chatId: event.chatId, approvalBatchId: 'purchase-application-1', executionRecordId: 'rec_one', cardMessageId: 'om_card', cardRevision: 3, materialType: 'receipt_photo', flowVersion: 'lifecycle_v1', createdAtMs: now - 2000, expiresAtMs: now + 10000 };
const binder = (value: VerifiedLifecycleReceiptImage | null = event) => ({ bind: async (raw: unknown, appId: string, intents: readonly LifecycleReceiptImageIntent[]) => matchVerifiedLifecycleReceiptImage(await createLifecycleReceiptImageVerifier(async () => value).verify(raw, appId), appId, intents, now) });

describe('lifecycle receipt image binding', () => {
  it('binds one verified message only to its exact server-owned intent', async () => {
    const result = await binder().bind({}, 'cli_test', [intent]);
    expect(result.intent).toEqual(intent);
    expect(result.event).toEqual(event);
    expect(result.eventFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.messageFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.intent).not.toBe(intent);
  });

  it('fails closed if transport identity is unavailable, changed, malformed or non-private', async () => {
    await expect(binder(null).bind({}, 'cli_test', [intent])).rejects.toThrow();
    await expect(createLifecycleReceiptImageVerifier(async () => { throw new Error('untrusted transport'); }).verify({}, 'cli_test')).rejects.toThrow();
    await expect(binder().bind({}, 'cli_other', [intent])).rejects.toThrow();
    for (const changed of [{ chatType: 'group' }, { senderType: 'bot' }, { messageType: 'file' }, { eventId: undefined }, { imageKey: undefined }, { messageCreatedAtMs: undefined }, { messageCreatedAtMs: now + 1 }]) {
      await expect(binder({ ...event, ...changed } as VerifiedLifecycleReceiptImage).bind({}, 'cli_test', [intent])).rejects.toThrow();
    }
  });

  it('never selects the newest one when multiple intents exist, even across batches', async () => {
    await expect(binder().bind({}, 'cli_test', [])).rejects.toThrow('不存在');
    await expect(binder().bind({}, 'cli_test', [intent, { ...intent, id: 'intent_other_12345', approvalBatchId: 'purchase-application-2', createdAtMs: now - 1500 }])).rejects.toThrow('多个候选');
    await expect(binder().bind({}, 'cli_test', [{ ...intent, chatId: 'oc_other' }])).rejects.toThrow('不属于');
    await expect(binder().bind({}, 'cli_test', [{ ...intent, actorOpenId: 'ou_other' }])).rejects.toThrow('不存在');
  });

  it('rejects an old, future, expired, malformed, or overly long window', async () => {
    await expect(binder({ ...event, messageCreatedAtMs: intent.createdAtMs - 1 }).bind({}, 'cli_test', [intent])).rejects.toThrow();
    await expect(binder().bind({}, 'cli_test', [{ ...intent, expiresAtMs: now - 1 }])).rejects.toThrow();
    await expect(binder().bind({}, 'cli_test', [{ ...intent, createdAtMs: now + 1 }])).rejects.toThrow();
    await expect(binder().bind({}, 'cli_test', [{ ...intent, expiresAtMs: intent.createdAtMs + 600001 }])).rejects.toThrow();
    await expect(binder().bind({}, 'cli_test', [{ ...intent, approvalBatchId: undefined } as unknown as LifecycleReceiptImageIntent])).rejects.toThrow();
    await expect(binder().bind({}, 'cli_test', [{ ...intent, executionRecordId: undefined } as unknown as LifecycleReceiptImageIntent])).rejects.toThrow();
    const verified = await createLifecycleReceiptImageVerifier(async () => event).verify({}, 'cli_test');
    expect(() => matchVerifiedLifecycleReceiptImage(verified, 'cli_test', [intent], NaN)).toThrow();
  });

  it('lets the ledger distinguish exact retries, same-event alteration and same-message alteration', async () => {
    const original = await binder().bind({}, 'cli_test', [intent]);
    const retry = await binder().bind({}, 'cli_test', [intent]);
    const altered = await binder({ ...event, imageKey: 'img_different' }).bind({}, 'cli_test', [intent]);
    const anotherEvent = await binder({ ...event, eventId: 'evt_retry' }).bind({}, 'cli_test', [intent]);
    expect(retry).toEqual(original);
    expect(altered.eventFingerprint).toBe(original.eventFingerprint);
    expect(altered.messageFingerprint).toBe(original.messageFingerprint);
    expect(altered.payloadFingerprint).not.toBe(original.payloadFingerprint);
    expect(anotherEvent.eventFingerprint).not.toBe(original.eventFingerprint);
    expect(anotherEvent.messageFingerprint).toBe(original.messageFingerprint);
    expect(anotherEvent.payloadFingerprint).toBe(original.payloadFingerprint);
  });

  it('creates a frozen detached snapshot outside the lock and matches synchronously inside it', async () => {
    const mutable = { ...event };
    const verifier = createLifecycleReceiptImageVerifier(async () => mutable);
    const verified = await verifier.verify({}, 'cli_test');
    mutable.imageKey = 'img_modified_after_verification';
    expect(Object.isFrozen(verified)).toBe(true);
    const result = matchVerifiedLifecycleReceiptImage(verified, 'cli_test', [intent], now);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.event.imageKey).toBe(event.imageKey);
    expect(() => matchVerifiedLifecycleReceiptImage({ ...verified } as VerifiedLifecycleReceiptImageSnapshot, 'cli_test', [intent], now)).toThrow('未经可信验证');
    expect(() => matchVerifiedLifecycleReceiptImage(verified, 'cli_other', [intent], now)).toThrow();
  });
  it('只从可信快照提取重放键，过期后可查旧结果但不能认领新意向', async () => {
    const verified=await createLifecycleReceiptImageVerifier(async()=>event).verify({},'cli_test');
    const existing=matchVerifiedLifecycleReceiptImage(verified,'cli_test',[intent],now);
    expect(extractVerifiedLifecycleReceiptImage(verified,'cli_test')).toEqual({event:existing.event,eventFingerprint:existing.eventFingerprint,messageFingerprint:existing.messageFingerprint,payloadFingerprint:existing.payloadFingerprint});
    expect(()=>matchVerifiedLifecycleReceiptImage(verified,'cli_test',[intent],intent.expiresAtMs+1)).toThrow();
    expect(()=>extractVerifiedLifecycleReceiptImage(Object.freeze({...verified}) as VerifiedLifecycleReceiptImageSnapshot,'cli_test')).toThrow('未经可信验证');
    expect(()=>extractVerifiedLifecycleReceiptImage(verified,'cli_other')).toThrow();
  });
});
