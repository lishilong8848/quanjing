import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { FeishuCardMirrorStore, MirrorStoreError, type MirrorClaim } from '../../server/common/feishu-card-copy/mirror.store';
import { sanitizeReadonlyCard } from '../../server/common/feishu-card-copy/readonly-card';
import { buildFollowUpProcessingCard, buildFollowUpResultCard } from '../../server/modules/bitable-sync/today-operations-follow-up-card';
import type { TodayOperationsFollowUpRecord } from '../../server/modules/bitable-sync/today-operations-anomaly.types';

describe('isolated readonly card delivery ledger', () => {
  const networkSpies: jest.SpyInstance[] = [];
  beforeAll(() => {
    for (const module of ['node:http', 'node:https']) for (const method of ['request', 'get']) networkSpies.push(jest.spyOn(require(module), method).mockImplementation(() => { throw Error('Unexpected outbound network in mirror-store tests'); }));
    if (typeof globalThis.fetch === 'function') networkSpies.push(jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Unexpected outbound fetch in mirror-store tests'); }));
  });
  afterAll(() => { for (const spy of networkSpies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); } });
  const identity = { appId: 'cli_synthetic', recipientOpenId: 'ou_observer', enabledAt: '2026-10-30T00:00:00.000Z' };
  const now = '2026-10-30T00:01:00.000Z';
  const pending = () => sanitizeReadonlyCard({ header: { title: { tag: 'plain_text', content: '审批' } }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '申请事项' } }, { tag: 'button', value: { recordId: 'recOne' } }] });
  const done = (text = '已通过') => sanitizeReadonlyCard({ header: { template: 'green', title: { tag: 'plain_text', content: '审批结果' } }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: text } }] });
  let directory: string, file: string, store: FeishuCardMirrorStore;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'feishu-card-copy-test-')); file = join(directory, 'mirror.json'); store = new FeishuCardMirrorStore(file, identity, { leaseMs: 1000 }); });
  afterEach(() => {
    const absolute = resolve(directory), base = resolve(tmpdir());
    if (!absolute.startsWith(base + require('node:path').sep) || !basename(absolute).startsWith('feishu-card-copy-test-')) throw Error('unsafe test cleanup');
    rmSync(absolute, { recursive: true, force: true });
  });
  const enroll = (id: string, originalRecipientOpenId = 'ou_approver', groupKey = 'purchase:recOne:approval') => store.enroll({ sourceMessageId: id, originalRecipientOpenId, groupKey, card: pending(), now, sourceStartedAt: now });

  it('enrolls future sends only, merges original recipients, and restarts without duplicate copies', async () => {
    await expect(store.enroll({ sourceMessageId: 'om_historical', groupKey: 'old', card: pending(), now, sourceStartedAt: '2026-10-29T23:00:00Z' })).resolves.toBeNull();
    const first = await enroll('om_source_one'), repeated = await enroll('om_source_one'), second = await enroll('om_source_two', 'ou_other');
    expect(repeated?.key).toBe(first?.key); expect(second?.sourceMessageIds).toEqual(['om_source_one', 'om_source_two']);
    const claim = (await store.claimNext(now))!; expect(claim.operation).toBe('create');
    await store.complete(claim, 'om_mirror', now);
    const restarted = new FeishuCardMirrorStore(file, identity);
    expect(restarted.isMirrorMessageId('om_mirror')).toBe(true); expect(restarted.isMirrorMessageId('om_source_one')).toBe(false);
    expect(await restarted.claimNext(now)).toBeNull();
    expect((await restarted.enroll({ sourceMessageId: 'om_source_one', originalRecipientOpenId: 'ou_approver', groupKey: 'changed-key', card: pending(), now }))?.messageId).toBe('om_mirror');
  });
  it('never enrolls an unknown historical card merely because it was patched', async () => {
    expect(await store.reserveUpdate('om_unknown')).toBeNull(); expect(store.getBySource('om_unknown')).toBeNull();
    expect(Object.keys(store.read().groups)).toHaveLength(0); expect(existsSync(file)).toBe(false);
  });
  it('allows one worker claim across store instances and rejects stale completion tokens', async () => {
    await enroll('om_source'); const other = new FeishuCardMirrorStore(file, identity);
    const [a,b] = await Promise.all([store.claimNext(now), other.claimNext(now)]);
    expect([a,b].filter(Boolean)).toHaveLength(1); const claim = (a || b)!;
    expect(await other.complete({ ...claim, token: 'not-the-token' }, 'om_wrong', now)).toBe(false);
    expect(await store.complete(claim, 'om_correct', now)).toBe(true);
  });
  it('claims only the explicitly selected group and leaves other pending cards untouched', async () => {
    const other = (await enroll('om_other', 'ou_approver', 'other-business'))!;
    const target = (await enroll('om_release', 'ou_approver', 'current-release'))!;
    const claim = (await store.claimNext(now, target.key))!;
    expect(claim.groupKey).toBe(target.key);
    expect(store.getBySource('om_other')).toMatchObject({ state: 'pending', attempts: 0 });
    await store.complete(claim, 'om_release_copy', now);
    expect(await store.claimNext(now, target.key)).toBeNull();
    expect((await store.claimNext(now))?.groupKey).toBe(other.key);
  });
  it('does not fall back to unrelated pending cards for missing, in-flight or unknown groups', async () => {
    await enroll('om_other', 'ou_approver', 'other-business');
    const target = (await enroll('om_release', 'ou_approver', 'current-release'))!;
    expect(await store.claimNext(now, 'missing-group')).toBeNull();
    expect(await store.claimNext(now, '')).toBeNull();
    const claim = (await store.claimNext(now, target.key))!;
    expect(await store.claimNext(now, target.key)).toBeNull();
    await store.fail(claim, { unknown: true, errorCode: 'TIMEOUT' }, now);
    expect(await store.claimNext(now, target.key)).toBeNull();
    expect(store.getBySource('om_other')).toMatchObject({ state: 'pending', attempts: 0 });
  });
  it('suppresses duplicate copy when observer already receives an original direct card', async () => {
    await enroll('om_source'); await enroll('om_native', 'ou_observer');
    expect(await store.claimNext(now)).toBeNull(); expect(store.getBySource('om_source')?.state).toBe('suppressed');
  });
  it('recalls only its own copy when native recipient appears after sending', async () => {
    await enroll('om_source'); const send = (await store.claimNext(now))!; await store.complete(send, 'om_mirror', now);
    await enroll('om_native', 'ou_observer'); const recall = (await store.claimNext(now))!;
    expect(recall).toMatchObject({ operation: 'recall', messageId: 'om_mirror' });
    await store.complete(recall, undefined, now); expect(store.getBySource('om_native')?.state).toBe('suppressed');
    expect(await store.claimNext(now)).toBeNull();
  });
  it('handles native delivery while a copy create is in flight without touching the original', async () => {
    await enroll('om_source'); const send = (await store.claimNext(now))!;
    await enroll('om_native', 'ou_observer'); expect(await store.claimNext(now)).toBeNull();
    await store.complete(send, 'om_mirror', now);
    expect((await store.claimNext(now))?.operation).toBe('recall');
  });
  it('updates enrolled copies monotonically, including an update arriving during creation', async () => {
    await enroll('om_source'); const send = (await store.claimNext(now))!;
    const first = (await store.reserveUpdate('om_source'))!, second = (await store.reserveUpdate('om_source'))!;
    await store.applyUpdate('om_source', second, done('最后结果'), now);
    await store.applyUpdate('om_source', first, done('旧结果'), now);
    await store.complete(send, 'om_mirror', now);
    const update = (await store.claimNext(now))!; expect(update.operation).toBe('update'); expect(JSON.stringify(update.card)).toContain('最后结果');
    await store.complete(update, undefined, now); expect(store.getBySource('om_source')?.appliedRevision).toBe(2);
  });
  it('updates a processing card to the real result with navigation buttons while the copy remains read-only', async () => {
    const record: TodayOperationsFollowUpRecord = { recordId: 'recSynthetic', issueKey: 'issueSynthetic', date: '2026-10-30', source: '每日巡视', item: '合成检查项', description: '待处理异常', building: 'A楼', acknowledged: true, completed: true, treatmentMeasure: '已完成检查', handlerName: '合成人员', handledAt: '2026-10-30 10:00' };
    const processing = sanitizeReadonlyCard(buildFollowUpProcessingCard(record, record));
    const result = sanitizeReadonlyCard(buildFollowUpResultCard('a'.repeat(32), { record, revision: 1 }, 0));
    expect(processing.hasEnabledActions).toBe(false); expect(result.hasEnabledActions).toBe(true);
    await enroll('om_source');
    await store.applyUpdate('om_source', (await store.reserveUpdate('om_source'))!, processing, now);
    expect(store.getBySource('om_source')?.revision).toBe(2);
    await store.applyUpdate('om_source', (await store.reserveUpdate('om_source'))!, result, now);
    const stored = store.getBySource('om_source')!;
    expect(stored.revision).toBe(3); expect(stored.terminal).toBe(false);
    expect(JSON.stringify(stored.readonlyCard)).toContain('已处理完成');
    expect(JSON.stringify(stored.readonlyCard)).not.toMatch(/"button"|behaviors|callback|form_action_type/);
  });
  it('does not replace a newer PATCH when another recipient initial card arrives late', async () => {
    await enroll('om_source'); await store.complete((await store.claimNext(now))!, 'om_mirror', now);
    await store.applyUpdate('om_source', (await store.reserveUpdate('om_source'))!, done('最新处理结果'), now);
    const update = (await store.claimNext(now))!; expect(update).toMatchObject({ operation: 'update', messageId: 'om_mirror', revision: 2 });
    await store.complete(update, undefined, now);
    await enroll('om_delayed_approver', 'ou_delayed');
    expect(await store.claimNext(now)).toBeNull();
    expect(store.getBySource('om_delayed_approver')?.revision).toBe(2);
    expect(JSON.stringify(store.getBySource('om_delayed_approver')?.readonlyCard)).toContain('最新处理结果');
  });
  it('orders updates across all original recipients and discards an older response arriving last', async () => {
    await enroll('om_first'); await enroll('om_second', 'ou_second');
    const first = (await store.reserveUpdate('om_first'))!, second = (await store.reserveUpdate('om_second'))!;
    expect(second.sequence).toBeGreaterThan(first.sequence);
    await expect(store.applyUpdate('om_second', first, done('冒用其它源的 token'), now)).rejects.toMatchObject({ code: 'UPDATE_INVALID' });
    await store.applyUpdate('om_second', second, done('新结果'), now);
    expect(store.read().sources.om_first.reservations).toEqual({});
    await store.cancelUpdate(first);
    await store.applyUpdate('om_first', first, done('旧结果'), now);
    expect(store.getBySource('om_first')?.revision).toBe(2);
    expect(JSON.stringify(store.getBySource('om_first')?.readonlyCard)).toContain('新结果');
    const next = (await store.reserveUpdate('om_first'))!;
    expect(next.sequence).toBeGreaterThan(second.sequence);
    await store.applyUpdate('om_first', next, done('后续新结果'), now);
    expect(store.getBySource('om_second')?.revision).toBe(3);
  });
  it('cancels an old source operation without releasing another source reservation', async () => {
    await enroll('om_first'); await enroll('om_second', 'ou_second');
    const first = (await store.reserveUpdate('om_first'))!, second = (await store.reserveUpdate('om_second'))!;
    await store.cancelUpdate(first);
    expect(store.read().sources.om_second.reservations[second.operationId]).toBe(second.sequence);
    await expect(store.applyUpdate('om_first', first, done('取消的结果'), now)).rejects.toMatchObject({ code: 'UPDATE_NOT_RESERVED' });
    await store.applyUpdate('om_second', second, done('新结果'), now);
    await store.applyUpdate('om_first', first, done('迟到的旧结果'), now);
    expect(JSON.stringify(store.getBySource('om_first')?.readonlyCard)).toContain('新结果');
  });
  it('keeps unknown create outcomes stopped across restart and rejects raw error content', async () => {
    await enroll('om_source'); const claim = (await store.claimNext(now))!;
    await store.fail(claim, { unknown: true, retryAt: now, errorCode: 'TIMEOUT' }, now);
    const restarted = new FeishuCardMirrorStore(file, identity);
    expect(await restarted.claimNext('2026-11-01T00:00:00Z')).toBeNull(); expect(restarted.getBySource('om_source')?.state).toBe('unknown');
    await expect(restarted.fail(claim, { unknown: true, errorCode: 'private password=secret' })).rejects.toMatchObject({ code: 'FAILURE_INVALID' });
  });
  it('retries a known-message PATCH after a transient or ambiguous error without creating a new copy', async () => {
    await enroll('om_source'); await store.complete((await store.claimNext(now))!, 'om_mirror', now);
    await store.applyUpdate('om_source', (await store.reserveUpdate('om_source'))!, done(), now);
    const update = (await store.claimNext(now))!; await store.fail(update, { unknown: true, retryAt: '2026-10-30T00:01:10Z', errorCode: 'TIMEOUT' }, now);
    expect(await store.claimNext(now)).toBeNull(); const retry = (await store.claimNext('2026-10-30T00:01:11Z'))!;
    expect(retry).toMatchObject({ operation: 'update', messageId: 'om_mirror', uuid: update.uuid });
  });
  it('does not steal a live worker even after lease expiry; dead-worker create becomes unknown', async () => {
    await enroll('om_source'); await store.claimNext(now);
    expect(await store.recoverInterrupted('2026-10-30T00:01:02Z')).toBe(0);
    const state = JSON.parse(readFileSync(file,'utf8')); const group: any = Object.values(state.groups)[0];
    group.claim.owner.processStartedAtMs = 1; writeFileSync(file, JSON.stringify(state));
    expect(await store.recoverInterrupted('2026-10-30T00:01:00.500Z')).toBe(0);
    expect(await store.recoverInterrupted('2026-10-30T00:01:02Z')).toBe(1);
    expect(await store.claimNext('2026-10-30T00:01:03Z')).toBeNull(); expect(store.getBySource('om_source')?.state).toBe('unknown');
  });
  it('rejects cross-app/recipient reuse, unsafe stored cards, and forged mirrored message IDs', async () => {
    await enroll('om_source');
    expect(() => new FeishuCardMirrorStore(file, { ...identity, appId: 'cli_other' }).read()).toThrow(MirrorStoreError);
    expect(() => new FeishuCardMirrorStore(file, { ...identity, recipientOpenId: 'ou_other' }).read()).toThrow(MirrorStoreError);
    const claim = (await store.claimNext(now))!;
    await expect(store.complete(claim, 'om_source', now)).rejects.toMatchObject({ code: 'MIRROR_MESSAGE_INVALID' });
    await store.complete(claim, 'om_mirror', now);
    await expect(enroll('om_mirror')).rejects.toMatchObject({ code: 'MIRROR_RECURSION' });
    const state = JSON.parse(readFileSync(file,'utf8')); (Object.values(state.groups)[0] as any).readonlyCard.elements.push({ tag: 'button', value: { action: 'approve' } });
    writeFileSync(file,JSON.stringify(state)); expect(()=>store.read()).toThrow(MirrorStoreError);
  });
  it('fails closed at capacity without dropping existing dedupe records', async () => {
    store = new FeishuCardMirrorStore(file, identity, { maxGroups: 1 }); await enroll('om_source'); const bytes = readFileSync(file);
    await expect(enroll('om_different', 'ou_other', 'other-business')).rejects.toMatchObject({ code: 'LEDGER_CAPACITY' });
    expect(readFileSync(file).equals(bytes)).toBe(true); expect(store.capacity().level).toBe('full');
  });
  it('does not silently recreate a missing ledger or clear a malformed one', async () => {
    await enroll('om_source'); rmSync(file); expect(()=>store.read()).toThrow(MirrorStoreError);
    writeFileSync(file,'not-json'); const before=readFileSync(file); await expect(enroll('om_other')).rejects.toThrow(MirrorStoreError); expect(readFileSync(file).equals(before)).toBe(true);
  });
});
