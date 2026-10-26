import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlarmReviewStore } from './alarm-review.store';
import * as processOwner from '../../common/process-lock-owner';

describe('durable alarm review outbox', () => {
  let dir: string;
  let store: AlarmReviewStore;
  const input = { recordIds: ['recA', 'recB'], outcome: '人工复核无问题' as const, responsibleRecordId: 'recPerson', clientMutationId: 'alarm-review-12345678' };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alarm-review-')); store = new AlarmReviewStore(join(dir, 'ledger.json')); });
  afterEach(() => { jest.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  it('persists before accepting and reuses identical mutation IDs across restarts', () => {
    const task = store.create(input, '示例人员019', 'user123', 'principal');
    expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).tasks[0].id).toBe(task.id);
    expect(new AlarmReviewStore(join(dir, 'ledger.json')).create(input, '示例人员019', 'user123', 'principal').id).toBe(task.id);
    expect(() => store.create({ ...input, outcome: '已通知现场跟进' }, '示例人员019', 'user123', 'principal')).toThrow();
    expect(() => store.create(input, '示例人员019', 'user123', 'anotherPrincipal')).toThrow();
  });
  it('blocks concurrent unresolved reviews; successful records are not retried', () => {
    const task = store.create(input, '示例人员019', 'user123', 'principal');
    expect(() => store.create({ ...input, clientMutationId: 'alarm-review-another123' }, '示例人员019', 'user123', 'principal')).toThrow();
    const lease = store.claim(task.id)!;
    expect(store.claim(task.id)).toBeNull();
    store.finishItem(task.id, lease, 'recA', null);
    store.finishItem(task.id, lease, 'recB', '飞书不可用');
    store.release(task.id, lease);
    expect(store.get(task.id, 'principal').items.map((item) => item.state)).toEqual(['success', 'error']);
    store.retry(task.id, 'principal');
    expect(store.get(task.id, 'principal').items.map((item) => item.state)).toEqual(['success', 'pending']);
  });
  it('persists a custom reply across restarts and prevents mutation reuse with different text', () => {
    const custom = { ...input, outcome: '自定义回复' as never, customReply: '等待备件' };
    const task = store.create(custom, '示例人员019', 'user123', 'principal');
    const restarted = new AlarmReviewStore(join(dir, 'ledger.json'));
    expect(restarted.get(task.id, 'principal').customReply).toBe('等待备件');
    expect(() => restarted.create({ ...custom, customReply: '已完成' }, '示例人员019', 'user123', 'principal')).toThrow('其他复核内容');
  });
  it('fails closed for a corrupt ledger instead of pretending empty', () => {
    writeFileSync(join(dir, 'ledger.json'), '{');
    expect(() => store.create(input, '示例人员019', 'user123', 'principal')).toThrow();
  });
  it('does not expose tasks to a different authenticated session', () => {
    const task = store.create(input, '示例人员019', 'user123', 'principal');
    expect(() => store.get(task.id, 'another')).toThrow();
  });
  it('recovers an accepted mutation after the submit response was lost', () => {
    const task = store.create(input, '示例人员019', 'user123', 'principal');
    expect(store.findByMutation(input.clientMutationId, 'principal')?.id).toBe(task.id);
    expect(store.findByMutation('alarm-review-unknown123', 'principal')).toBeNull();
    expect(() => store.findByMutation(input.clientMutationId, 'another')).toThrow();
  });
  it('reclaims an interrupted worker without rewriting completed records', () => {
    const task = store.create(input, '示例人员019', 'user123', 'principal');
    const oldLease = store.claim(task.id)!;
    store.finishItem(task.id, oldLease, 'recA', null);
    jest.spyOn(processOwner, 'processLockOwnerMayBeAlive').mockReturnValue(false);
    const restarted = new AlarmReviewStore(join(dir, 'ledger.json'));
    const newLease = restarted.claim(task.id)!;
    expect(newLease).not.toBe(oldLease);
    expect(restarted.get(task.id, 'principal').items.map((item) => item.state)).toEqual(['success', 'syncing']);
    expect(() => store.finishItem(task.id, oldLease, 'recB', null)).toThrow();
    restarted.finishItem(task.id, newLease, 'recB', null);
    restarted.release(task.id, newLease);
    expect(restarted.listReady()).toHaveLength(0);
  });
});
