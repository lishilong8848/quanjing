import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuCardMirrorStore } from '../../server/common/feishu-card-copy/mirror.store';
import { FeishuCardCopyEngine } from '../../server/common/feishu-card-copy/card-copy.engine';
import { observedCardPost, observedCardPatch, observedCardTokenUpdate, observeCardCallbackResult, isReadonlyCopyCallback, registerCardCopyObserver } from '../../server/common/feishu-card-copy/transport';

describe('readonly mirror orchestration without application or network', () => {
  let directory: string, store: FeishuCardMirrorStore, engine: FeishuCardCopyEngine, http: any, valid: boolean, removeObserver: () => void;
  const startedAt = '2026-10-30T01:00:00.000Z';
  const card = { header: { title: { tag: 'plain_text', content: '合成审批' }, template: 'blue' }, elements: [
    { tag: 'div', text: { tag: 'plain_text', content: '物品：合成物品' } },
    { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '同意' }, value: { recordId: 'recSynthetic', actorOpenId: 'ou_original', ticket: 'never-forward-this' } }] },
  ] };
  const success = (messageId = 'om_copy') => ({ status: 200, data: { code: 0, data: { message_id: messageId } } });
  const source = (messageId: string, recipientId = 'ou_original') => ({ source: 'purchase', messageId, card, recipientId, recipientType: 'open_id', startedAt });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'readonly-card-engine-'));
    store = new FeishuCardMirrorStore(join(directory, 'ledger.json'), { appId: 'cli_synthetic', recipientOpenId: 'ou_copy', enabledAt: startedAt });
    http = { post: jest.fn(async () => success()), patch: jest.fn(async () => success()), delete: jest.fn(async () => success()) }; valid = true;
    engine = new FeishuCardCopyEngine({ store, http, accessToken: async () => 'synthetic-only-token', targetValid: () => valid, diagnostic: jest.fn(), now: () => new Date(startedAt) });
    removeObserver = registerCardCopyObserver(engine);
  });
  afterEach(() => { engine.stop(); removeObserver(); rmSync(directory, { recursive: true, force: true }); });
  it('coalesces one card across original recipients and never forwards action secrets', async () => {
    await engine.delivered(source('om_original1')); await engine.delivered(source('om_original2', 'ou_other')); await engine.flush();
    expect(http.post).toHaveBeenCalledTimes(1);
    const payload = http.post.mock.calls[0][1];
    expect(payload.receive_id).toBe('ou_copy'); expect(payload.msg_type).toBe('interactive');
    expect(payload.content).toContain('只读抄送'); expect(payload.content).not.toMatch(/never-forward|actorOpenId|recordId|"button"|"value"/);
    expect(Object.keys(store.read().groups)).toHaveLength(1);
    expect(isReadonlyCopyCallback({ context: { open_message_id: 'om_copy' }, action: { value: { action: 'approve' } } })).toBe(true);
    expect(isReadonlyCopyCallback({ context: { open_message_id: 'om_original1' } })).toBe(false);
  });
  it('does not add a duplicate if the observer also receives an original direct card', async () => {
    await engine.delivered(source('om_original1')); await engine.delivered(source('om_own', 'ou_copy')); await engine.flush();
    expect(http.post).not.toHaveBeenCalled(); expect(http.delete).not.toHaveBeenCalled();
    expect(Object.values(store.read().groups)[0].state).toBe('suppressed');
  });
  it('deduplicates identified business cards across midnight and preserves native-recipient suppression', async () => {
    await engine.delivered({ ...source('om_before_midnight'), startedAt: '2026-10-30T15:59:00.000Z' });
    await engine.delivered({ ...source('om_after_midnight', 'ou_copy'), startedAt: '2026-10-30T16:01:00.000Z' });
    await engine.flush();
    expect(Object.keys(store.read().groups)).toHaveLength(1); expect(http.post).not.toHaveBeenCalled();
  });
  it('recalls only its own copy if an original native card arrives later', async () => {
    await engine.delivered(source('om_original1')); await engine.flush(); await engine.delivered(source('om_own', 'ou_copy')); await engine.flush();
    expect(http.delete.mock.calls[0][0]).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_copy');
    expect(http.delete).toHaveBeenCalledTimes(1);
  });
  it('does not scan history and does not create copies when only an old-card update is observed', async () => {
    await observeCardCallbackResult('leave', { messageId: 'om_history' }, { card: { type: 'raw', data: card } }); await engine.flush();
    expect(http.post).not.toHaveBeenCalled(); expect(Object.keys(store.read().groups)).toHaveLength(0);
  });
  it('updates the enrolled copy after legal callback response, including cross-domain gateways', async () => {
    await engine.delivered(source('om_original1')); await engine.flush();
    const final = { header: { title: { tag: 'plain_text', content: '审批通过' }, template: 'green' }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '已完成' } }] };
    await observeCardCallbackResult('today-operations', { deliveryMessageId: 'om_original1' }, { card: { type: 'raw', data: final } }); await engine.flush();
    expect(http.patch.mock.calls[0][0].endsWith('/om_copy')).toBe(true);
    expect(http.patch.mock.calls[0][1].content).toContain('审批通过'); expect(http.post).toHaveBeenCalledTimes(1);
  });
  it('keeps unknown delivery stopped across retries instead of blindly sending twice', async () => {
    http.post.mockRejectedValueOnce(new Error('synthetic timeout'));
    await engine.delivered(source('om_original1')); await engine.flush(); await engine.flush();
    expect(http.post).toHaveBeenCalledTimes(1); expect(Object.values(store.read().groups)[0].state).toBe('unknown');
  });
  it('one-off dispatch only flushes its explicit source and leaves other queued cards alone', async () => {
    await engine.delivered(source('om_older'));
    await engine.delivered({ ...source('om_newer'), card: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'new release only' } }] } });
    expect(await engine.flushSource('om_missing')).toBe(0);
    expect(await engine.flushSource('om_newer')).toBe(1);
    expect(http.post).toHaveBeenCalledTimes(1); expect(http.post.mock.calls[0][1].content).toContain('new release only');
    expect(store.getBySource('om_older')?.state).toBe('pending'); expect(await engine.flushSource('om_newer')).toBe(0);
  });
  it('rejects inactive or changed target without touching original delivery', async () => {
    valid = false; const original = { post: jest.fn(async () => success('om_primary')) };
    const payload = { receive_id: 'ou_original', msg_type: 'interactive', content: JSON.stringify(card) };
    await expect(observedCardPost(original as never, 'purchase', 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', payload, {})).resolves.toEqual(success('om_primary'));
    await engine.flush(); expect(original.post).toHaveBeenCalledWith(expect.any(String), payload, {}); expect(http.post).not.toHaveBeenCalled();
  });
  it('releases reserved update intents if original PATCH fails or returns an API rejection', async () => {
    await engine.delivered(source('om_original1'));
    const primary = { patch: jest.fn().mockRejectedValueOnce(new Error('original failure')).mockResolvedValueOnce({ status: 200, data: { code: 999 } }) };
    const url = 'https://open.feishu.cn/open-apis/im/v1/messages/om_original1';
    await expect(observedCardPatch(primary as never, 'purchase', url, { content: JSON.stringify(card) }, {})).rejects.toThrow('original failure');
    await observedCardPatch(primary as never, 'purchase', url, { content: JSON.stringify(card) }, {});
    expect(store.read().sources.om_original1.reservations).toEqual({});
  });
  it('does not turn a confirmed primary send into failure when the separate copy ledger is corrupt', async () => {
    writeFileSync(store.filePath, '{corrupt synthetic ledger');
    const original = { post: jest.fn(async () => success('om_primary')) };
    await expect(observedCardPost(original as never, 'purchase', 'https://open.feishu.cn/open-apis/im/v1/messages', { receive_id: 'ou_original', msg_type: 'interactive', content: JSON.stringify(card) }, {})).resolves.toEqual(success('om_primary'));
    expect(original.post).toHaveBeenCalledTimes(1); expect(http.post).not.toHaveBeenCalled();
  });
  it.each(['patch', 'token', 'callback'])('releases capture reservations after %s storage failure and allows later updates', async mode => {
    await engine.delivered(source('om_original1'));
    const apply = jest.spyOn(store, 'applyUpdate').mockRejectedValueOnce(new Error('synthetic capacity failure'));
    const primary = { post: jest.fn(async () => success()), patch: jest.fn(async () => success()) };
    if (mode === 'patch') await observedCardPatch(primary as never, 'purchase', 'https://open.feishu.cn/open-apis/im/v1/messages/om_original1', { content: JSON.stringify(card) }, {});
    else if (mode === 'token') await observedCardTokenUpdate(primary as never, 'purchase', 'https://open.feishu.cn/open-apis/interactive/v1/card/update', { token: 'private-token', card }, {}, 'om_original1');
    else await observeCardCallbackResult('purchase', { messageId: 'om_original1' }, { card: { type: 'raw', data: card } });
    expect(store.read().sources.om_original1.reservations).toEqual({}); apply.mockRestore();
    await observeCardCallbackResult('purchase', { messageId: 'om_original1' }, { card: { type: 'raw', data: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'recovered capture' } }] } } });
    expect(JSON.stringify(store.getBySource('om_original1')?.readonlyCard)).toContain('recovered capture');
  });
  it('keeps primary PATCH success even when both copy capture and reservation cleanup fail', async () => {
    await engine.delivered(source('om_original1'));
    const apply = jest.spyOn(store, 'applyUpdate').mockRejectedValueOnce(new Error('synthetic storage failure'));
    const cancel = jest.spyOn(store, 'cancelUpdate').mockRejectedValueOnce(new Error('synthetic cleanup failure'));
    const primary = { patch: jest.fn(async () => success()) };
    await expect(observedCardPatch(primary as never, 'purchase', 'https://open.feishu.cn/open-apis/im/v1/messages/om_original1', { content: JSON.stringify(card) }, {})).resolves.toEqual(success());
    expect(primary.patch).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1); apply.mockRestore(); cancel.mockRestore();
  });
  it('never persists callback update tokens, and preserves original request exactly', async () => {
    await engine.delivered(source('om_original1'));
    const primary = { post: jest.fn(async () => success()) }, body = { token: 'c-private-token', card };
    await observedCardTokenUpdate(primary as never, 'purchase', 'https://open.feishu.cn/open-apis/interactive/v1/card/update', body, {}, 'om_original1');
    expect(primary.post).toHaveBeenCalledWith(expect.any(String), body, {}); expect(JSON.stringify(store.read())).not.toContain('c-private-token');
  });
  it('does not enroll text messages or foreign hosts', async () => {
    const original = { post: jest.fn(async () => success('om_primary')) };
    await observedCardPost(original as never, 'purchase', 'https://open.feishu.cn/open-apis/im/v1/messages', { receive_id: 'ou_original', msg_type: 'text', content: 'hello' }, {});
    await observedCardPost(original as never, 'purchase', 'https://example.invalid/open-apis/im/v1/messages', { receive_id: 'ou_original', msg_type: 'interactive', content: JSON.stringify(card) }, {});
    expect(Object.keys(store.read().groups)).toHaveLength(0);
  });
});
