import { createLifecyclePrivateChatVerifier } from '../../server/modules/purchase-inventory/purchase-lifecycle-private-chat-verifier';

const identity = Object.freeze({ appId: 'cli_test', actorOpenId: 'ou_actor', cardMessageId: 'om_card', chatId: 'oc_chat' });
function setup() {
  let now = 100_000;
  const message = { message_id: identity.cardMessageId, chat_id: identity.chatId, msg_type: 'interactive', deleted: false,
    sender: { id: identity.appId, id_type: 'app_id', sender_type: 'app' } };
  const transport = {
    currentAppId: jest.fn(() => identity.appId),
    readCard: jest.fn(async () => ({ code: 0, data: { items: [message] } })),
    readChat: jest.fn(async () => ({ code: 0, data: { chat_mode: 'p2p' } })),
    readMembers: jest.fn(async (_appId: string, _chatId: string, _token?: string) => ({ code: 0, data: {
      items: [{ member_id_type: 'open_id', member_id: identity.actorOpenId }], has_more: false, trigger_security_conf_limit: false,
    } })),
  };
  return { transport, verifier: createLifecyclePrivateChatVerifier(transport, () => now), setTime: (value: number) => { now = value; } };
}
describe('purchase lifecycle private chat proof (isolated)', () => {
  it('binds app, source card, chat and only human member; locks can synchronously assert a frozen proof', async () => {
    const f = setup(); const proof = await f.verifier.verify(identity);
    expect(Object.isFrozen(proof)).toBe(true); expect(() => f.verifier.assertProof(proof, identity)).not.toThrow();
    expect(f.transport.readCard).toHaveBeenCalledWith(identity.appId, identity.cardMessageId);
    expect(f.transport.readMembers).toHaveBeenCalledWith(identity.appId, identity.chatId, undefined);
    expect(() => f.verifier.assertProof({ ...proof }, identity)).toThrow();
    expect(() => f.verifier.assertProof(proof, { ...identity, actorOpenId: 'ou_other' })).toThrow();
    f.setTime(proof.validUntilMs + 1); expect(() => f.verifier.assertProof(proof, identity)).toThrow();
    f.setTime(proof.verifiedAtMs - 1); expect(() => f.verifier.assertProof(proof, identity)).toThrow();
  });
  it.each([
    { message_id: 'om_other' }, { chat_id: 'oc_other' }, { deleted: true }, { msg_type: 'text' },
    { sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app' } },
    { sender: { id: identity.appId, id_type: 'open_id', sender_type: 'app' } },
  ])('rejects mismatched or deleted card %p', async change => {
    const f = setup(); const original = (await f.transport.readCard()).data.items[0];
    f.transport.readCard.mockResolvedValue({ code: 0, data: { items: [{ ...original, ...change }] } } as never);
    await expect(f.verifier.verify(identity)).rejects.toThrow();
  });
  it('does not confuse a private group with p2p and rejects missing or failed responses', async () => {
    const f = setup(); f.transport.readChat.mockResolvedValue({ code: 0, data: { chat_mode: 'group', chat_type: 'private' } } as never);
    await expect(f.verifier.verify(identity)).rejects.toThrow();
    f.transport.readChat.mockResolvedValue({ code: 403 } as never); await expect(f.verifier.verify(identity)).rejects.toThrow();
    f.transport.readChat.mockResolvedValue({ code: 0, data: {} } as never); await expect(f.verifier.verify(identity)).rejects.toThrow();
  });
  it.each([
    { items: [], has_more: false, trigger_security_conf_limit: false },
    { items: [{ member_id_type: 'open_id', member_id: 'ou_other' }], has_more: false, trigger_security_conf_limit: false },
    { items: [{ member_id_type: 'open_id', member_id: identity.actorOpenId }], has_more: false },
    { items: [{ member_id_type: 'open_id', member_id: identity.actorOpenId }], has_more: false, trigger_security_conf_limit: true },
    { items: [{ member_id_type: 'open_id', member_id: identity.actorOpenId }], has_more: true, trigger_security_conf_limit: false },
    { items: [{ member_id_type: 'open_id', member_id: identity.actorOpenId }, { member_id_type: 'open_id', member_id: 'ou_other' }], has_more: false, trigger_security_conf_limit: false },
  ])('rejects incomplete, restricted or different membership %p', async data => {
    const f = setup(); f.transport.readMembers.mockResolvedValue({ code: 0, data } as never);
    await expect(f.verifier.verify(identity)).rejects.toThrow();
  });
  it('reads every page, rejects repeated pagination tokens, and fails on an app switch', async () => {
    const f = setup();
    f.transport.readMembers.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: 'next', trigger_security_conf_limit: false } } as never);
    const proof = await f.verifier.verify(identity); f.verifier.assertProof(proof, identity);
    expect(f.transport.readMembers).toHaveBeenLastCalledWith(identity.appId, identity.chatId, 'next');
    f.transport.readMembers.mockResolvedValue({ code: 0, data: { items: [], has_more: true, page_token: 'same', trigger_security_conf_limit: false } } as never);
    await expect(f.verifier.verify(identity)).rejects.toThrow();
    f.transport.currentAppId.mockReturnValue('cli_other'); expect(() => f.verifier.assertProof(proof, identity)).toThrow();
  });
  it('rejects a transport that changes apps mid-read or whose verification becomes stale', async () => {
    const f = setup(); f.transport.readCard.mockImplementation(async () => { f.transport.currentAppId.mockReturnValue('cli_other'); return { code: 0, data: { items: [] } }; });
    await expect(f.verifier.verify(identity)).rejects.toThrow();
    const slow = setup(); slow.transport.readChat.mockImplementation(async () => { slow.setTime(130_001); return { code: 0, data: { chat_mode: 'p2p' } }; });
    await expect(slow.verifier.verify(identity)).rejects.toThrow();
  });
});
