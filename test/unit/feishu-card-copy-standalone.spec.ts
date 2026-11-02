jest.mock('http', () => ({ ...jest.requireActual('http'), request: () => { throw new Error('Unexpected HTTP'); }, get: () => { throw new Error('Unexpected HTTP'); } }));
jest.mock('https', () => ({ ...jest.requireActual('https'), request: () => { throw new Error('Unexpected HTTPS'); }, get: () => { throw new Error('Unexpected HTTPS'); } }));
jest.mock('node:http', () => jest.requireMock('http'));
jest.mock('node:https', () => jest.requireMock('https'));
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { copyStandaloneCardNotice, copyStandaloneCardNotices, type StandaloneCardNoticeOptions, type StandaloneCardTargetProof } from '../../server/common/feishu-card-copy/standalone';
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
    ['inactive', { active: false }], ['unverified', { verified: false }], ['empty name', { name: '' }],
    ['blank name', { name: '  ' }], ['control character in name', { name: '刘\n小杏' }],
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
  const secondProof = (): StandaloneCardTargetProof => ({ ...proof(), name: '刘小杏', openId: 'ou_second_synthetic',
    identityFingerprint: createHash('sha256').update(`${appId}\0ou_second_synthetic`).digest('hex') });
  const targets = () => [
    { storePath: options.storePath, targetProof: proof() },
    { storePath: join(folder, 'second-readonly-mirror.json'), targetProof: secondProof() },
  ];
  it('accepts another explicitly verified person without weakening identity proof requirements', async () => {
    expect(await copyStandaloneCardNotice({ ...options, targetProof: secondProof() })).toMatchObject({ status: 'delivered', sentConfirmed: true });
    expect(http.post.mock.calls[0][1].receive_id).toBe('ou_second_synthetic');
  });
  it('sends two independent read-only copies and deduplicates their replay after reopening the ledgers', async () => {
    http.post.mockImplementation(async (_url, body) => ({ status: 200, data: { code: 0, data: { message_id: `om_copy_${body.receive_id}` } } }));
    const recipientTargets = targets();
    const result = await copyStandaloneCardNotices({ ...options, targets: recipientTargets });
    expect(result).toHaveLength(2); expect(result.every(row => row.sentConfirmed)).toBe(true);
    expect(new Set(result.map(row => row.copyMessageId)).size).toBe(2);
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(new Set(http.post.mock.calls.map(call => call[1].receive_id))).toEqual(new Set([openId, 'ou_second_synthetic']));
    expect(new Set(http.post.mock.calls.map(call => call[1].uuid)).size).toBe(2);
    for (const call of http.post.mock.calls) {
      expect(call[1].content).toContain('只读抄送'); expect(call[1].content).not.toMatch(/private-action|"button"|"action"\s*:/);
    }
    expect((await copyStandaloneCardNotices({ ...options, targets: recipientTargets })).every(row => row.sentConfirmed)).toBe(true);
    expect(http.post).toHaveBeenCalledTimes(2);
    for (const target of recipientTargets) expect(JSON.parse(readFileSync(target.storePath, 'utf8')).recipientOpenId).toBe(target.targetProof.openId);
  });
  it('deduplicates an identical Open ID before any send', async () => {
    const [first, second] = targets();
    const result = await copyStandaloneCardNotices({ ...options, targets: [first, { ...first, targetProof: { ...first.targetProof } }, second] });
    expect(result).toHaveLength(2); expect(http.post).toHaveBeenCalledTimes(2);
  });
  it('isolates a corrupt ledger from another recipient', async () => {
    const recipientTargets = targets(); writeFileSync(recipientTargets[0].storePath, '{broken');
    const result = await copyStandaloneCardNotices({ ...options, targets: recipientTargets });
    expect(result[0]).toMatchObject({ recipientOpenId: openId, status: 'unavailable', sentConfirmed: false });
    expect(result[1]).toMatchObject({ recipientOpenId: 'ou_second_synthetic', status: 'delivered', sentConfirmed: true });
    expect(http.post).toHaveBeenCalledTimes(1); expect(http.post.mock.calls[0][1].receive_id).toBe('ou_second_synthetic');
    expect(readFileSync(recipientTargets[0].storePath, 'utf8')).toBe('{broken');
  });
  it('retries a rate-limited recipient without resending the successful recipient', async () => {
    let secondCalls = 0;
    http.post.mockImplementation(async (_url, body) => {
      if (body.receive_id === 'ou_second_synthetic' && ++secondCalls === 1) return { status: 429, data: { code: 99991400 } };
      return { status: 200, data: { code: 0, data: { message_id: `om_copy_${body.receive_id}` } } };
    });
    const recipientTargets = targets();
    const first = await copyStandaloneCardNotices({ ...options, targets: recipientTargets });
    expect(first[0].sentConfirmed).toBe(true); expect(first[1].sentConfirmed).toBe(false);
    const second = await copyStandaloneCardNotices({ ...options, now: () => new Date(time + 61_000), targets: recipientTargets });
    expect(second.every(row => row.sentConfirmed)).toBe(true);
    expect(http.post.mock.calls.filter(call => call[1].receive_id === openId)).toHaveLength(1);
    expect(http.post.mock.calls.filter(call => call[1].receive_id === 'ou_second_synthetic')).toHaveLength(2);
  });
  it('never retries an unknown recipient result while retaining the other success', async () => {
    http.post.mockImplementation(async (_url, body) => {
      if (body.receive_id === 'ou_second_synthetic') throw new Error('synthetic timeout');
      return { status: 200, data: { code: 0, data: { message_id: 'om_first_copy' } } };
    });
    const batch = { ...options, targets: targets() };
    expect((await copyStandaloneCardNotices(batch))[1]).toMatchObject({ status: 'unknown', sentConfirmed: false });
    const replay = await copyStandaloneCardNotices(batch);
    expect(replay[0].sentConfirmed).toBe(true); expect(replay[1].status).toBe('unknown');
    expect(http.post).toHaveBeenCalledTimes(2);
  });
  it('rejects a shared ledger for different recipients before writing or sending either copy', async () => {
    const recipientTargets = targets(); recipientTargets[1].storePath = resolve(folder, '.', basename(options.storePath));
    const result = await copyStandaloneCardNotices({ ...options, targets: recipientTargets });
    expect(result.every(row => row.reasonCode === 'STANDALONE_SHARED_LEDGER_REJECTED')).toBe(true);
    expect(http.post).not.toHaveBeenCalled(); expect(existsSync(options.storePath)).toBe(false);
  });
  it('rejects conflicting duplicate recipient storage while still sending an independent target', async () => {
    const [first, second] = targets();
    const result = await copyStandaloneCardNotices({ ...options, targets: [first, { ...first, storePath: join(folder, 'conflicting.json') }, second] });
    expect(result[0]).toMatchObject({ reasonCode: 'STANDALONE_DUPLICATE_TARGET_CONFLICT', sentConfirmed: false });
    expect(result[1].sentConfirmed).toBe(true); expect(http.post).toHaveBeenCalledTimes(1);
    expect(existsSync(first.storePath)).toBe(false); expect(existsSync(join(folder, 'conflicting.json'))).toBe(false);
  });
  it('isolates an invalid identity proof and never recovers its older unrequested publication', async () => {
    const recipientTargets = targets();
    accessToken.mockRejectedValue(new Error('synthetic auth unavailable'));
    const first = await copyStandaloneCardNotices({ ...options, targets: recipientTargets });
    expect(first.every(row => row.status === 'pending')).toBe(true);
    accessToken.mockResolvedValue('synthetic-access-token');
    const later = time + 70_000;
    recipientTargets[1].targetProof = { ...secondProof(), identityFingerprint: 'a'.repeat(64) };
    const next = await copyStandaloneCardNotices({ ...options, now: () => new Date(later), targets: recipientTargets,
      event: { ...options.event, messageId: 'om_primary_end', uuid: 'synthetic-end-uuid', startedAt: new Date(later - 500).toISOString(),
        card: { ...card, header: { title: { tag: 'plain_text', content: '南通全景平台 · 更新结束' } } } } });
    expect(next[0].sentConfirmed).toBe(true); expect(next[1].reasonCode).toBe('STANDALONE_TARGET_PROOF_INVALID');
    expect(http.post).toHaveBeenCalledTimes(1); expect(http.post.mock.calls[0][1].content).toContain('更新结束');
    for (const target of targets()) expect(new FeishuCardMirrorStore(target.storePath, { appId, recipientOpenId: target.targetProof.openId }).getBySource('om_primary_start')?.state).toBe('pending');
  });
  it('bounds recipient count before any side effect', async () => {
    await expect(copyStandaloneCardNotices({ ...options, targets: Array.from({ length: 11 }, () => targets()[0]) })).rejects.toThrow('STANDALONE_TARGETS_INVALID');
    expect(http.post).not.toHaveBeenCalled(); expect(existsSync(options.storePath)).toBe(false);
  });
  (process.platform === 'win32' ? it : it.skip).each(['.', ' '])('rejects Windows ledger aliases ending with %j without affecting a valid target', async suffix => {
    const recipientTargets = targets(); recipientTargets[1].storePath = options.storePath + suffix;
    const result = await copyStandaloneCardNotices({ ...options, targets: recipientTargets });
    expect(result[0].sentConfirmed).toBe(true);
    expect(result[1]).toMatchObject({ status: 'skipped', reasonCode: 'STANDALONE_CONFIGURATION_INVALID' });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(options.storePath, 'utf8')).recipientOpenId).toBe(openId);
  });
});
