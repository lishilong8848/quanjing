jest.mock('http', () => ({ ...jest.requireActual('http'), request: () => { throw new Error('Unexpected HTTP'); }, get: () => { throw new Error('Unexpected HTTP'); } }));
jest.mock('https', () => ({ ...jest.requireActual('https'), request: () => { throw new Error('Unexpected HTTPS'); }, get: () => { throw new Error('Unexpected HTTPS'); } }));
jest.mock('node:http', () => jest.requireMock('http'));
jest.mock('node:https', () => jest.requireMock('https'));
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { copyStandaloneCardNotice, type StandaloneCardNoticeOptions, type StandaloneCardTargetProof } from '../../server/common/feishu-card-copy/standalone';
import { FeishuCardMirrorStore } from '../../server/common/feishu-card-copy/mirror.store';

const appId = 'cli_standalone_synthetic', openId = 'ou_standalone_synthetic';
const time = Date.parse('2026-10-30T02:00:00.000Z');
const card = { header: { title: { tag: 'plain_text', content: '南通全景平台 · 更新开始' } }, elements: [
  { tag: 'div', text: { tag: 'lark_md', content: '合成发布内容' } },
  { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '批准' }, value: { action: 'approve', token: 'private-action' } }] },
] };
const proof = (): StandaloneCardTargetProof => ({ name: '李世龙', appId, openId, active: true, verified: true,
  identityFingerprint: createHash('sha256').update(`${appId}\0${openId}`).digest('hex'), checkedAt: new Date(time - 60_000).toISOString() });

describe('standalone release card copies without application bootstrap', () => {
  let folder: string, parent: string, options: StandaloneCardNoticeOptions;
  let http: { post: jest.Mock; patch: jest.Mock; delete: jest.Mock }, accessToken: jest.Mock;
  beforeEach(() => {
    parent = realpathSync(tmpdir()); folder = mkdtempSync(join(parent, 'nt-standalone-card-'));
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
    http = { post: jest.fn(async () => ({ status: 200, data: { code: 0, data: { message_id: 'om_synthetic_copy' } } })), patch: jest.fn(), delete: jest.fn() };
    accessToken = jest.fn(async () => 'synthetic-access-token');
    options = { event: { source: 'release-notice', messageId: 'om_primary_start', card, recipientId: 'oc_synthetic_release', recipientType: 'chat_id', uuid: 'synthetic-start-uuid', startedAt: new Date(time - 1_000).toISOString() },
      http: http as never, accessToken, storePath: join(folder, 'release-notice-card-readonly-mirror.json'), appId, targetProof: proof(), now: () => new Date(time) };
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (dirname(resolve(folder)) !== parent || !/^nt-standalone-card-/.test(basename(folder)) || lstatSync(folder).isSymbolicLink() || realpathSync(folder) !== folder) throw new Error('Unsafe fixture cleanup');
    rmSync(folder, { recursive: true, force: false });
  });
  it('accepts a freshly verified pre-send identity after the primary receipt and persists only a display copy', async () => {
    const result = await copyStandaloneCardNotice(options);
    expect(result).toMatchObject({ status: 'delivered', sentConfirmed: true, sourceMessageId: 'om_primary_start', copyMessageId: 'om_synthetic_copy' });
    expect(http.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = http.post.mock.calls[0];
    expect(url).toContain('receive_id_type=open_id'); expect(body.receive_id).toBe(openId);
    expect(config.headers.Authorization).toBe('Bearer synthetic-access-token');
    expect(body.content).toContain('只读抄送'); expect(body.content).not.toMatch(/private-action|"button"|"action"\s*:/);
    const persisted = readFileSync(options.storePath, 'utf8');
    expect(persisted).not.toMatch(/synthetic-access-token|private-action/);
    expect(new FeishuCardMirrorStore(options.storePath, { appId, recipientOpenId: openId }).getBySource('om_primary_start')?.state).toBe('delivered');
    expect(http.patch).not.toHaveBeenCalled(); expect(http.delete).not.toHaveBeenCalled();
  });
  it('replaying the successful original message never sends a second copy', async () => {
    await copyStandaloneCardNotice(options);
    expect(await copyStandaloneCardNotice({ ...options })).toMatchObject({ status: 'delivered', sentConfirmed: true });
    expect(http.post).toHaveBeenCalledTimes(1);
  });
  it('never retries an unknown original copy outcome', async () => {
    http.post.mockRejectedValue(new Error('synthetic timeout'));
    expect(await copyStandaloneCardNotice(options)).toMatchObject({ status: 'unknown', sentConfirmed: false });
    expect(await copyStandaloneCardNotice(options)).toMatchObject({ status: 'unknown', sentConfirmed: false });
    expect(http.post).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['different app', { appId: 'cli_other_synthetic' }], ['different identity', { identityFingerprint: 'a'.repeat(64) }],
    ['inactive', { active: false }], ['unverified', { verified: false }], ['wrong person', { name: '同名以外人员' }],
    ['expired', { checkedAt: new Date(time - 15 * 60_000 - 1).toISOString() }],
    ['checked after original send', { checkedAt: new Date(time).toISOString() }],
  ])('skips %s proof without any token/network/file action', async (_label, change) => {
    options.targetProof = { ...proof(), ...(change as object) } as StandaloneCardTargetProof;
    expect(await copyStandaloneCardNotice(options)).toMatchObject({ status: 'skipped', sentConfirmed: false, reasonCode: 'STANDALONE_TARGET_PROOF_INVALID' });
    expect(accessToken).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled(); expect(existsSync(options.storePath)).toBe(false);
  });
  it('rechecks proof after token acquisition and stops if it expires during that wait', async () => {
    let current = time; options.now = () => new Date(current);
    accessToken.mockImplementation(async () => { current += 15 * 60_000; return 'synthetic-access-token'; });
    expect(await copyStandaloneCardNotice(options)).toMatchObject({ status: 'pending', sentConfirmed: false });
    expect(http.post).not.toHaveBeenCalled();
  });
  it('does not flush another historical pending publication when sending this phase', async () => {
    accessToken.mockRejectedValueOnce(new Error('synthetic auth unavailable'));
    expect(await copyStandaloneCardNotice(options)).toMatchObject({ status: 'pending', sentConfirmed: false });
    const later = time + 70_000;
    const next = { ...options, now: () => new Date(later), targetProof: { ...proof(), checkedAt: new Date(later - 1_000).toISOString() },
      event: { ...options.event, messageId: 'om_primary_end', uuid: 'synthetic-end-uuid', startedAt: new Date(later - 500).toISOString(), card: { ...card, header: { title: { tag: 'plain_text', content: '南通全景平台 · 更新结束' } } } } };
    expect(await copyStandaloneCardNotice(next)).toMatchObject({ status: 'delivered', sentConfirmed: true, sourceMessageId: 'om_primary_end' });
    expect(http.post).toHaveBeenCalledTimes(1); expect(http.post.mock.calls[0][1].content).toContain('更新结束');
    expect(new FeishuCardMirrorStore(options.storePath, { appId, recipientOpenId: openId }).getBySource('om_primary_start')?.state).toBe('pending');
  });
  it('reports a malformed delivery receipt as unknown, never delivered', async () => {
    http.post.mockResolvedValue({ status: 200, data: { code: 0, data: {} } });
    expect(await copyStandaloneCardNotice(options)).toMatchObject({ status: 'unknown', sentConfirmed: false });
  });
  it('reports a rejected copy while leaving the accepted primary result alone', async () => {
    http.post.mockResolvedValue({ status: 400, data: { code: 230001 } });
    expect(await copyStandaloneCardNotice(options)).toMatchObject({ status: 'failed', sentConfirmed: false });
  });
  it('does not repair a corrupt ledger or return a false success', async () => {
    writeFileSync(options.storePath, '{broken');
    expect(await copyStandaloneCardNotice(options)).toMatchObject({ status: 'unavailable', sentConfirmed: false });
    expect(readFileSync(options.storePath, 'utf8')).toBe('{broken'); expect(http.post).not.toHaveBeenCalled();
  });
  it('only accepts an explicit group release-notice event and dedicated absolute path', async () => {
    expect(await copyStandaloneCardNotice({ ...options, event: { ...options.event, source: 'purchase' } })).toMatchObject({ status: 'skipped' });
    expect(await copyStandaloneCardNotice({ ...options, storePath: 'relative-ledger.json' })).toMatchObject({ status: 'skipped' });
    expect(http.post).not.toHaveBeenCalled();
  });
});
