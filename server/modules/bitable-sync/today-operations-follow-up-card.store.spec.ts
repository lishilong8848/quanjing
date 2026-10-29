import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { TodayOperationsFollowUpCardStore } from './today-operations-follow-up-card.store';
import type { TodayOperationsFollowUpRecord } from './today-operations-anomaly.types';
const disk = require('node:fs/promises') as typeof import('node:fs/promises');

const batchA = 'a'.repeat(32), batchB = 'b'.repeat(32);
const appId = 'cli_test_followup', messageA = 'om_cardA', messageB = 'om_cardB';

function record(id = 'recA', patch: Partial<TodayOperationsFollowUpRecord> = {}): TodayOperationsFollowUpRecord {
  return { recordId: id, issueKey: `issue-${id}`, date: '2026-10-29', source: '每日巡视', item: '测试异常',
    description: '合成测试记录', building: 'A楼', acknowledged: false, completed: false,
    treatmentMeasure: '', handlerName: '', handledAt: '', ...patch };
}
function input(patch: Partial<Parameters<TodayOperationsFollowUpCardStore['claim']>[0]> = {}) {
  return { batchId: batchA, messageId: messageA, index: 0, revision: 1, acknowledged: true,
    completed: false, treatmentMeasure: '检查中', actorOpenId: 'ou_actorA', actorName: '测试人员', ...patch };
}

describe('TodayOperationsFollowUpCardStore', () => {
  let directory: string, path: string, store: TodayOperationsFollowUpCardStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'followup-card-store-'));
    path = join(directory, 'ledger.json');
    store = new TodayOperationsFollowUpCardStore(path);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep + 'followup-card-store-')) throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true, force: true });
  });
  async function prepare(records = [record()]) {
    await store.prepareBatch(batchA, appId, records);
    await store.bindMessage(batchA, messageA, { header: { title: '合成巡视摘要' } });
    if (records.length) await store.setView(batchA, messageA, { kind: 'edit', index: 0 });
  }
  async function finish(id: string, messages = [messageA]) {
    for (const messageId of messages) await store.markPatched(id, messageId);
    await store.complete(id);
  }

  it('rejects a new claim atomically after the message leaves its edit view', async () => {
    await prepare([record(), record('recB')]);
    await store.setView(batchA, messageA, { kind: 'summary' });
    await expect(store.claim(input())).rejects.toThrow('卡片页面已切换');
    await store.setView(batchA, messageA, { kind: 'edit', index: 1 });
    await expect(store.claim(input())).rejects.toThrow('卡片页面已切换');
    expect(await store.pendingCommands()).toEqual([]);
    await store.setView(batchA, messageA, { kind: 'edit', index: 0 });
    expect((await store.claim(input())).claimed).toBe(true);
  });

  it.each([128, 129, 252])('accepts a platform message identifier with %i suffix characters', async length => {
    await prepare();
    const message = `om_${'a'.repeat(length)}`;
    await store.bindMessage(batchA, message, { tag: 'summary' });
    expect((await store.getSnapshot(batchA, message)).batch.id).toBe(batchA);
    expect(() => store.bindMessage(batchA, `om_${'a'.repeat(253)}`, { tag: 'summary' })).toThrow('消息无效');
  });

  it('keeps Unicode measures intact and uses the same character limit as the form', async () => {
    await prepare();
    const measure = '😀'.repeat(300);
    const claim = await store.claim(input({ completed: true, treatmentMeasure: measure }));
    expect((await store.pendingCommands())[0].update.treatmentMeasure).toBe(measure);
    expect(claim.command.update.treatmentMeasure).toBe(measure);
    expect(() => store.claim(input({ treatmentMeasure: '😀'.repeat(501) }))).toThrow('参数无效');
    expect(() => store.claim(input({ completed: true, treatmentMeasure: '😀' }))).toThrow('处理措施');
  });

  it('pins batch membership/order, refreshes external changes once and deep-clones input/output', async () => {
    const first = record(), second = record('recB');
    const waiting = store.prepareBatch(batchA, appId, [first, second]);
    first.description = 'caller mutation';
    const initial = await waiting;
    expect(initial.records[0].record.description).toBe('合成测试记录');
    initial.batch.recordIds.reverse(); initial.records[0].record.item = 'mutated response';
    const same = await store.prepareBatch(batchA, appId, [second, record()]);
    expect(same.batch.recordIds).toEqual(['recA', 'recB']);
    expect(same.records.map(item => item.revision)).toEqual([1, 1]);
    await expect(store.prepareBatch(batchA, appId, [record()])).rejects.toThrow('范围已固定');
    await expect(store.prepareBatch(batchA, 'cli_other', [record(), second])).rejects.toThrow('范围已固定');
    await store.prepareBatch(batchA, appId, [record('recA', { description: '外部修改' }), second]);
    const next = await store.getSnapshot(batchA);
    expect(next.records[0].revision).toBe(2);
    expect(next.records[0].record.description).toBe('外部修改');
    expect(next.records[1].revision).toBe(1);
  });

  it('rebinds one message to exactly one batch and keeps independent message views', async () => {
    await prepare();
    await store.bindMessage(batchA, messageB, { tag: 'summary' });
    await store.setView(batchA, messageA, { kind: 'edit', index: 0 });
    expect((await store.getSnapshot(batchA, messageB)).message?.view).toEqual({ kind: 'summary' });
    await store.prepareBatch(batchB, appId, [record('recB')]);
    await store.bindMessage(batchB, messageA, { tag: 'new-summary' });
    await expect(store.getSnapshot(batchA, messageA)).rejects.toThrow('不匹配');
    expect((await store.getSnapshot(batchB, messageA)).message?.view).toEqual({ kind: 'summary' });
    expect((await store.messagesForRecord('recA')).map(item => item.messageId)).toEqual([messageB]);
    await expect(store.setView(batchB, messageA, { kind: 'edit', index: 1 })).rejects.toThrow('视图无效');
  });

  it('accepts exactly one concurrent action per record/revision across messages and batches', async () => {
    await prepare();
    await store.prepareBatch(batchB, appId, [record()]);
    await store.bindMessage(batchB, messageB, { tag: 'summary' });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.claim(input({
      ...(index % 2 ? { batchId: batchB, messageId: messageB } : {}),
      actorOpenId: `ou_actor${index}`, actorName: `处理人${index}`, treatmentMeasure: `合成措施${index}`,
    }))));
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(new Set(results.map(result => result.command.id)).size).toBe(1);
    const command = results[0].command;
    expect(command.update.clientMutationId).toBe(`followup-card-${command.id}`);
    expect((await store.pendingCommands())).toHaveLength(1);
    expect((await store.getSnapshot(batchB, messageB)).records[0].pendingCommandId).toBe(command.id);
    results[1].command.update.treatmentMeasure = 'response mutation';
    expect((await store.pendingCommands())[0].update.treatmentMeasure).toBe('合成措施0');
    await store.refreshRecord(batchA, messageA, record('recA', { description: '迟到外部读取' }));
    await store.prepareBatch(batchB, appId, [record('recA', { description: '迟到扫描' })]);
    expect((await store.getSnapshot(batchA)).records[0].record.description).toBe('合成测试记录');
  });

  it('persists pending and written stages across restart without creating another command', async () => {
    await prepare();
    const claimed = await store.claim(input());
    store = new TodayOperationsFollowUpCardStore(path);
    expect((await store.pendingCommands())[0].stage).toBe('pending');
    expect((await store.claim(input())).claimed).toBe(false);
    const written = record('recA', { acknowledged: true, treatmentMeasure: '检查中', handlerName: '测试人员' });
    await store.markWritten(claimed.command.id, written);
    await store.markWritten(claimed.command.id, written);
    store = new TodayOperationsFollowUpCardStore(path);
    expect((await store.pendingCommands())[0].stage).toBe('written');
    expect((await store.getSnapshot(batchA)).records[0]).toMatchObject({ revision: 2, pendingCommandId: claimed.command.id });
    await expect(store.complete(claimed.command.id)).rejects.toThrow('卡片等待同步');
    await finish(claimed.command.id);
    store = new TodayOperationsFollowUpCardStore(path);
    expect(await store.pendingCommands()).toEqual([]);
    const replay = await store.claim(input());
    expect(replay.claimed).toBe(false);
    expect(replay.command.stage).toBe('completed');
    const next = await store.claim(input({ revision: 2, treatmentMeasure: '继续检查' }));
    expect(next.claimed).toBe(true);
    expect(next.command.id).not.toBe(claimed.command.id);
  });

  it('rejects invalid index, future revision, mismatched bindings and already completed external records', async () => {
    await prepare([record('recA', { acknowledged: true, completed: true, treatmentMeasure: '已完成' })]);
    await expect(store.claim(input())).rejects.toThrow('已处理完成');
    await expect(store.claim(input({ index: 1 }))).rejects.toThrow('位置无效');
    await expect(store.claim(input({ revision: 2 }))).rejects.toThrow('版本无效');
    await expect(store.claim(input({ messageId: messageB }))).rejects.toThrow('不匹配');
    expect(() => store.claim(input({ completed: true, treatmentMeasure: ' ' }))).toThrow('处理措施');
    expect(await store.pendingCommands()).toEqual([]);
  });

  it('keeps the completed result terminal, normalizes completion to acknowledged and returns old revisions', async () => {
    await prepare();
    const claimed = await store.claim(input({ acknowledged: false, completed: true, treatmentMeasure: '处理完毕' }));
    expect(claimed.command.update.acknowledged).toBe(true);
    await expect(store.complete(claimed.command.id)).rejects.toThrow('结果尚未确认');
    await store.markWritten(claimed.command.id, record('recA', { acknowledged: true, completed: true, treatmentMeasure: '处理完毕' }));
    await finish(claimed.command.id);
    const repeated = await store.claim(input({ revision: 2, completed: false }));
    expect(repeated.claimed).toBe(false);
    expect(repeated.command.id).toBe(claimed.command.id);
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).commands)).toHaveLength(1);
  });

  it('records conflicts without further business writes and recovers with a newer revision after patching', async () => {
    await prepare();
    const claimed = await store.claim(input());
    const external = record('recA', { treatmentMeasure: '外部已经修改', handlerName: '外部处理人' });
    await store.markConflict(claimed.command.id, external, new Error('外部记录已变化'));
    store = new TodayOperationsFollowUpCardStore(path);
    expect((await store.pendingCommands())[0]).toMatchObject({ stage: 'conflict', lastError: '外部记录已变化', result: external });
    expect((await store.claim(input({ revision: 2 }))).claimed).toBe(false);
    await expect(store.markWritten(claimed.command.id, record())).rejects.toThrow('结果已经确定');
    await finish(claimed.command.id);
    expect((await store.claim(input({ revision: 2 }))).claimed).toBe(true);
  });

  it('requires every current copy to be patched and invalidates a changed summary binding', async () => {
    await prepare();
    const claimed = await store.claim(input());
    await store.markWritten(claimed.command.id, record('recA', { acknowledged: true }));
    await store.markPatched(claimed.command.id, messageA);
    await store.bindMessage(batchA, messageB, { tag: 'summary' });
    await expect(store.complete(claimed.command.id)).rejects.toThrow('卡片等待同步');
    await store.markPatched(claimed.command.id, messageB);
    await store.bindMessage(batchA, messageA, { tag: 'replaced-summary' });
    await expect(store.complete(claimed.command.id)).rejects.toThrow('卡片等待同步');
    await store.markPatched(claimed.command.id, messageA);
    await store.complete(claimed.command.id);
  });

  it('persists bounded retry backoff and leaves the command stage intact', async () => {
    await prepare();
    const claimed = await store.claim(input());
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await store.recordFailure(claimed.command.id, new Error('temporary failure token=sensitive'));
    expect(await store.pendingCommands(now + 999)).toEqual([]);
    const first = (await store.pendingCommands(now + 1000))[0];
    expect(first).toMatchObject({ stage: 'pending', attempts: 1, lastError: 'temporary failure token=[redacted]' });
    for (let i = 0; i < 12; i += 1) await store.recordFailure(claimed.command.id, 'temporary failure');
    store = new TodayOperationsFollowUpCardStore(path);
    expect(await store.pendingCommands(now + 299_999)).toEqual([]);
    expect((await store.pendingCommands(now + 300_000))[0].attempts).toBe(13);
  });

  it('does not claim or advance revision when atomic rename fails, and the queue remains retryable', async () => {
    await prepare();
    const before = await readFile(path, 'utf8');
    jest.spyOn(disk, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'));
    await expect(store.claim(input())).rejects.toThrow('simulated rename failure');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await store.pendingCommands()).toEqual([]);
    expect(await readdir(directory)).toEqual(['ledger.json']);
    const claimed = await store.claim(input());
    jest.spyOn(disk, 'writeFile').mockRejectedValueOnce(new Error('simulated disk full'));
    await expect(store.markWritten(claimed.command.id, record('recA', { acknowledged: true }))).rejects.toThrow('simulated disk full');
    expect((await store.pendingCommands())[0].stage).toBe('pending');
    expect((await store.getSnapshot(batchA)).records[0].revision).toBe(1);
    await store.markWritten(claimed.command.id, record('recA', { acknowledged: true }));
    expect((await store.pendingCommands())[0].stage).toBe('written');
  });

  it.each(['{invalid-json', JSON.stringify({ version: 2, batches: {}, records: {}, messages: {}, commands: {} })])('fails closed without resetting a corrupt ledger: %s', async bytes => {
    await writeFile(path, bytes, 'utf8');
    await expect(store.prepareBatch(batchA, appId, [record()])).rejects.toThrow();
    await expect(store.pendingCommands()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it.each(['orphan', 'expected', 'missing-record', 'pending-result', 'created-at', 'empty-pointer'])('rejects corrupted %s state without repairing the ledger', async kind => {
    await prepare();
    const claimed = await store.claim(input());
    const value = JSON.parse(await readFile(path, 'utf8'));
    const command = value.commands[claimed.command.id];
    if (kind === 'orphan') delete value.records.recA.pendingCommandId;
    if (kind === 'expected') command.expected.description = 'corrupt expected state';
    if (kind === 'missing-record') delete value.records.recA;
    if (kind === 'pending-result') command.result = record();
    if (kind === 'created-at') command.createdAt = 1;
    if (kind === 'empty-pointer') value.records.recA.pendingCommandId = '';
    const corrupted = JSON.stringify(value);
    await writeFile(path, corrupted, 'utf8');
    await expect(store.getSnapshot(batchA, messageA)).rejects.toThrow('台账损坏');
    await expect(store.complete(claimed.command.id)).rejects.toThrow('台账损坏');
    expect(await readFile(path, 'utf8')).toBe(corrupted);
  });

  it('uses the dedicated environment path and lets an injected test path override it', async () => {
    const previous = process.env.TODAY_OPERATIONS_FOLLOW_UP_CARD_LEDGER_PATH;
    process.env.TODAY_OPERATIONS_FOLLOW_UP_CARD_LEDGER_PATH = join(directory, 'environment.json');
    try {
      await new TodayOperationsFollowUpCardStore().prepareBatch(batchA, appId, [record()]);
      await store.prepareBatch(batchB, appId, [record('recB')]);
      expect(Object.keys(JSON.parse(await readFile(join(directory, 'environment.json'), 'utf8')).batches)).toEqual([batchA]);
      expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).batches)).toEqual([batchB]);
    } finally {
      if (previous === undefined) delete process.env.TODAY_OPERATIONS_FOLLOW_UP_CARD_LEDGER_PATH;
      else process.env.TODAY_OPERATIONS_FOLLOW_UP_CARD_LEDGER_PATH = previous;
    }
  });
});
