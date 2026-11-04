const fs = require('node:fs/promises') as typeof import('node:fs/promises');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FairOperationQueue } from '../../server/common/fair-operation-queue';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { OvertimeWorkflowStore } from '../../server/modules/overtime-workflow/overtime-workflow.store';

const overtimeSnapshot = {
  recordId: 'rec_overtime_cache', applicantName: 'SYNTHETIC', applicantOpenId: 'ou_synthetic',
  building: 'A楼', position: '运维值班员', plannedStartAt: '2026-11-02T09:00:00+08:00',
  plannedEndAt: '2026-11-02T17:00:00+08:00', plannedHours: 8, reason: 'SYNTHETIC',
};

describe('fair card-operation scheduling', () => {
  it('keeps operations serial, preserves each queue order and lets bookkeeping run after four card operations', async () => {
    const queue = new FairOperationQueue();
    const order: string[] = [];
    let active = 0;
    const action = (id: string) => async () => {
      active += 1;
      expect(active).toBe(1);
      await Promise.resolve();
      order.push(id);
      active -= 1;
    };
    const pending = [queue.enqueue(action('b1')), queue.enqueue(action('b2'))];
    for (let i = 1; i <= 9; i++) pending.push(queue.enqueue(action(`c${i}`), true));
    await queue.idle();
    await Promise.all(pending);
    expect(order).toEqual(['c1', 'c2', 'c3', 'c4', 'b1', 'c5', 'c6', 'c7', 'c8', 'b2', 'c9']);
  });

  it('does not interrupt a running operation or stall the queue after its failure', async () => {
    const queue = new FairOperationQueue();
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const running = queue.enqueue(async () => { order.push('started'); await started; throw new Error('expected'); });
    const rejected = expect(running).rejects.toThrow('expected');
    await Promise.resolve();
    const card = queue.enqueue(async () => { order.push('card'); return 1; }, true);
    const background = queue.enqueue(async () => { order.push('background'); });
    expect(order).toEqual(['started']);
    release();
    await rejected;
    await expect(card).resolves.toBe(1);
    await background;
    await queue.idle();
    expect(order).toEqual(['started', 'card', 'background']);
  });
});

describe('content-verified ledger snapshots', () => {
  let directory: string;
  const stores: PurchaseWorkflowStore[] = [];
  beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'card-ledger-cache-')); });
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(stores.splice(0).map(store => store.onModuleDestroy()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const purchase = (file: string) => { const store = new PurchaseWorkflowStore(file); stores.push(store); return store; };

  it('observes same-length external changes even with mtime restored, across two instances', async () => {
    const file = join(directory, 'purchase.json');
    const first = purchase(file), second = purchase(file);
    await first.recordReminder('before');
    expect(await first.hasReminder('before')).toBe(true);
    expect(await second.hasReminder('before')).toBe(true);
    const prior = await fs.stat(file);
    const text = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, text.replace('before', 'after1'));
    await fs.utimes(file, prior.atime, prior.mtime);
    expect((await fs.stat(file)).size).toBe(prior.size);
    expect(await second.hasReminder('before')).toBe(false);
    expect(await first.hasReminder('after1')).toBe(true);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"version":2', '"version":X'));
    await expect(first.hasReminder('after1')).rejects.toThrow();
  });

  it.each(['writeFile', 'rename'] as const)('a failed %s keeps the old durable bytes and cannot poison the cached snapshot', async method => {
    const file = join(directory, 'purchase.json');
    const store = purchase(file);
    await store.recordReminder('retained');
    await store.hasReminder('retained');
    const bytes = await fs.readFile(file);
    jest.spyOn(fs, method).mockRejectedValueOnce(Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' }));
    await expect(store.recordReminder('failed')).rejects.toThrow('synthetic I/O failure');
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(await store.hasReminder('failed')).toBe(false);
    expect(await store.hasReminder('retained')).toBe(true);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await store.recordReminder('retry');
    expect(await store.hasReminder('retry')).toBe(true);
  });

  it('does not expose a cached command object, and preserves a single card decision across instances and restart', async () => {
    const file = join(directory, 'purchase.json');
    const first = purchase(file), second = purchase(file);
    await first.recordCommand({ key: 'synthetic-command', recordId: 'rec_synthetic', action: 'approve', actorOpenId: 'ou_actor', accessRole: 'admin', authenticationMode: 'feishu-oauth', completedAt: new Date().toISOString(), notificationWarnings: [] });
    const command = await first.findCommand('synthetic-command');
    command!.actorOpenId = 'ou_changed';
    expect((await second.findCommand('synthetic-command'))?.actorOpenId).toBe('ou_actor');
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).claimCardAction({ eventId: `evt_${i}`, recordId: 'rec_synthetic', action: 'approve', actorOpenId: 'ou_actor' })));
    expect(claims.filter(result => result.claimed)).toHaveLength(1);
    await first.onModuleDestroy();
    await second.onModuleDestroy();
    const restarted = purchase(file);
    expect((await restarted.listCardActions()).length).toBe(1);
    expect((await restarted.claimCardAction({ eventId: 'evt_retry', recordId: 'rec_synthetic', action: 'reject', actorOpenId: 'ou_other' })).claimed).toBe(false);
  });

  it('keeps overtime snapshots isolated and revalidates external authorization snapshots before a decision', async () => {
    const file = join(directory, 'overtime.json');
    const store = new OvertimeWorkflowStore(file, file);
    await store.acceptApplication({ clientMutationId: 'synthetic-cache', snapshot: overtimeSnapshot });
    const application = await store.getApplication(overtimeSnapshot.recordId);
    application!.snapshot.applicantName = 'LOCAL_MUTATION';
    expect((await store.getApplication(overtimeSnapshot.recordId))?.snapshot.applicantName).toBe('SYNTHETIC');
    const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
    ledger.applications[0].phase = 'approval_pending';
    ledger.applications[0].approvers = [{ openId: 'ou_approver', name: 'SYNTHETIC' }];
    ledger.applications[0].approvalCards = [{ recipientOpenId: 'ou_approver', messageId: 'om_synthetic', businessKey: 'synthetic-card' }];
    await fs.writeFile(file, JSON.stringify(ledger));
    await store.getApplication(overtimeSnapshot.recordId);
    ledger.applications[0].approvers = [{ openId: 'ou_changed1', name: 'SYNTHETIC' }];
    await fs.writeFile(file, JSON.stringify(ledger));
    await expect(store.claimApprovalAction({ eventId: 'evt_overtime', recordId: overtimeSnapshot.recordId, action: 'approve', actorOpenId: 'ou_approver', messageId: 'om_synthetic' })).rejects.toThrow('不是该加班申请的审批人');
    expect((await store.listTasks()).filter(task => task.kind === 'apply_approval')).toHaveLength(0);
  });

  it('a failed overtime decision write does not change the durable approval state or retry identity', async () => {
    const file = join(directory, 'overtime.json');
    const store = new OvertimeWorkflowStore(file, file);
    await store.acceptApplication({ clientMutationId: 'synthetic-failure', snapshot: overtimeSnapshot });
    await store.patchApplication(overtimeSnapshot.recordId, { phase: 'approval_pending', approvers: [{ openId: 'ou_approver', name: 'SYNTHETIC' }], approvalCards: [{ recipientOpenId: 'ou_approver', messageId: 'om_synthetic', businessKey: 'synthetic-card' }] });
    await store.getApplication(overtimeSnapshot.recordId);
    const bytes = await fs.readFile(file);
    const input = { eventId: 'evt_overtime_retry', recordId: overtimeSnapshot.recordId, action: 'approve' as const, actorOpenId: 'ou_approver', messageId: 'om_synthetic' };
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }));
    await expect(store.claimApprovalAction(input)).rejects.toThrow('synthetic rename failure');
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(await store.getApprovalAction(overtimeSnapshot.recordId)).toBeNull();
    expect((await store.claimApprovalAction(input)).claimed).toBe(true);
    expect((await store.claimApprovalAction(input)).claimed).toBe(false);
    expect((await store.listTasks()).filter(task => task.kind === 'apply_approval')).toHaveLength(1);
  });
});
