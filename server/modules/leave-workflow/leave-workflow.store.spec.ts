import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeaveWorkflowStore } from './leave-workflow.store';

describe('LeaveWorkflowStore', () => {
  let directory = '';
  let store: LeaveWorkflowStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'leave-workflow-'));
    store = new LeaveWorkflowStore(join(directory, 'ledger.json'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('prioritizes new routing over an older slow detail synchronization task', async () => {
    await store.enqueueTask({ businessKey: 'older-detail', recordId: 'rec_leave_1', kind: 'sync_leave_shift_details' });
    await store.acceptApplication(application());
    await expect(store.takeNextTask()).resolves.toMatchObject({ kind: 'route_application' });
  });

  it('lets a card read overtake queued background ledger work without interrupting an active write', async () => {
    await store.acceptApplication(application());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const running = (store as any).enqueue(async () => { order.push('write-start'); await gate; order.push('write-end'); });
    await new Promise<void>(resolve => setImmediate(resolve));
    const background = Array.from({ length: 8 }, (_, i) =>
      (store as any).enqueue(async () => { order.push(`background-${i}`); }, false));
    const callback = store.getApplication('rec_leave_1').then(row => { order.push('card'); return row; });
    release();
    await Promise.all([running, ...background, callback]);
    expect(order.slice(0, 3)).toEqual(['write-start', 'write-end', 'card']);
    expect(await callback).not.toBeNull();
  });

  it('bounds the priority burst and continues the ledger queue after a failed operation', async () => {
    await store.acceptApplication(application());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const running = (store as any).enqueue(() => gate);
    await new Promise<void>(resolve => setImmediate(resolve));
    const background = (store as any).enqueue(async () => { order.push('background'); }, false);
    const callbacks = Array.from({ length: 8 }, (_, i) =>
      store.getApplication('rec_leave_1').then(() => { order.push(`card-${i}`); }));
    release();
    await Promise.all([running, background, ...callbacks]);
    expect(order.indexOf('background')).toBeGreaterThan(0);
    expect(order.indexOf('background')).toBeLessThanOrEqual(4);
    await expect((store as any).enqueue(async () => { throw Error('synthetic'); }, true)).rejects.toThrow('synthetic');
    await expect(store.getApplication('rec_leave_1')).resolves.not.toBeNull();
  });

  it('does not overtake a business mutation already queued before the card read', async () => {
    await store.acceptApplication(application());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = (store as any).enqueue(() => gate, false);
    await new Promise<void>(resolve => setImmediate(resolve));
    const update = store.patchApplication('rec_leave_1', { lastError: 'new business state' });
    const read = store.getApplication('rec_leave_1');
    release();
    await Promise.all([running, update]);
    expect((await read)?.lastError).toBe('new business state');
  });

  it('normalizes only the requested application on reads but validates all records on mutations', async () => {
    await store.acceptApplication(application());
    await store.acceptApplication({ ...application(), recordId: 'rec_leave_2', clientMutationId: 'other-request' });
    const normalize = jest.spyOn(store as any, 'normalizeApplicationForRead');
    await store.getApplication('rec_leave_1');
    expect(normalize.mock.calls.map(([entry]) => (entry as { recordId: string }).recordId)).toEqual(['rec_leave_1']);
    normalize.mockClear();
    await store.patchApplication('rec_leave_1', { lastError: 'write-check' });
    expect(normalize.mock.calls.map(([entry]) => (entry as { recordId: string }).recordId).sort()).toEqual(['rec_leave_1', 'rec_leave_2']);
  });

  it('reuses exact-input normalization without sharing mutable application state', async () => {
    await store.acceptApplication(application());
    const dates = jest.spyOn(Date.prototype, 'toISOString');
    const first = (await store.getApplication('rec_leave_1'))!;
    expect(dates).toHaveBeenCalled();
    dates.mockClear();
    first.snapshot.applicantName = 'MUTATED';
    const next = (await store.getApplication('rec_leave_1'))!;
    expect(next.snapshot.applicantName).toBe('张三');
    expect(dates).not.toHaveBeenCalled();
  });

  it('invalidates normalization for external same-size edits even when timestamps are restored', async () => {
    await store.acceptApplication(application());
    await store.getApplication('rec_leave_1');
    const filesystem = require('node:fs/promises'), file = join(directory, 'ledger.json');
    const before = await filesystem.stat(file);
    const content = await readFile(file, 'utf8');
    await writeFile(file, content.replace('张三', '李四'), 'utf8');
    await filesystem.utimes(file, before.atime, before.mtime);
    expect((await filesystem.stat(file)).size).toBe(before.size);
    expect((await store.getApplication('rec_leave_1'))!.snapshot.applicantName).toBe('李四');
    await writeFile(file, content.replace('2026-08-17T18:00:00+08:00', '2026-08-16T18:00:00+08:00'), 'utf8');
    await expect(store.getApplication('rec_leave_1')).rejects.toThrow('请休假结束时间不能早于开始时间');
  });

  it('observes deleted, corrupt and recreated ledgers after warming the read snapshot', async () => {
    await store.acceptApplication(application());
    const file = join(directory, 'ledger.json'), original = await readFile(file, 'utf8');
    await store.getApplication('rec_leave_1');
    await rm(file);
    expect(await store.getApplication('rec_leave_1')).toBeNull();
    await writeFile(file, '{invalid', 'utf8');
    await expect(store.getApplication('rec_leave_1')).rejects.toThrow();
    await writeFile(file, original.replace('张三', '李四'), 'utf8');
    expect((await store.getApplication('rec_leave_1'))?.snapshot.applicantName).toBe('李四');
  });

  it('does not leak an uncommitted task lease into the cached ledger after save failure', async () => {
    await store.acceptApplication(application());
    const file = join(directory, 'ledger.json'), original = await readFile(file, 'utf8');
    const rename = jest.spyOn(require('node:fs/promises'), 'rename').mockRejectedValue(new Error('synthetic disk failure'));
    try { await expect(store.takeNextTask()).rejects.toThrow('synthetic disk failure'); }
    finally { rename.mockRestore(); }
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await store.listTasks()).toEqual([expect.objectContaining({ status: 'pending', attempts: 0, claimToken: '' })]);
    expect(await store.takeNextTask()).toMatchObject({ status: 'processing', attempts: 1 });
  });

  it('still validates a corrupt unrelated application before committing from a warm read snapshot', async () => {
    await store.acceptApplication(application());
    await store.acceptApplication({ ...application(), recordId: 'rec_leave_2', clientMutationId: 'second' });
    const file = join(directory, 'ledger.json'), ledger = JSON.parse(await readFile(file, 'utf8'));
    ledger.applications[1].snapshot.endAt = '2026-08-16T18:00:00+08:00';
    const original = JSON.stringify(ledger); await writeFile(file, original, 'utf8');
    expect(await store.getApplication('rec_leave_1')).not.toBeNull();
    await expect(store.patchApplication('rec_leave_1', { lastError: 'must not commit' })).rejects.toThrow('请休假结束时间不能早于开始时间');
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('preserves external edits and JSON escaping when another application is saved from a warm snapshot', async () => {
    await store.acceptApplication(application());
    await store.acceptApplication({ ...application(), recordId: 'rec_leave_2', clientMutationId: 'second' });
    await store.listApplications();
    const file = join(directory, 'ledger.json'), original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('张三', '李四'), 'utf8');
    const message = '中文 "quote" \\ slash\nline }],"tasks":[]';
    await store.patchApplication('rec_leave_2', { lastError: message });
    await store.enqueueTask({ recordId: 'rec_leave_2', businessKey: 'escaped-task', kind: 'sync_leave_shift_details', payload: { message } });
    const reopened = new LeaveWorkflowStore(file);
    expect((await reopened.getApplication('rec_leave_1'))?.snapshot.applicantName).toBe('李四');
    expect((await reopened.getApplication('rec_leave_2'))?.lastError).toBe(message);
    expect((await reopened.listTasks()).find(task => task.businessKey === 'escaped-task')?.payload.message).toBe(message);
  });

  it('does not retain a parsed ledger over the snapshot memory limit', async () => {
    await store.acceptApplication(application());
    const file = join(directory, 'ledger.json'), ledger = JSON.parse(await readFile(file, 'utf8'));
    ledger.unusedMetadata = 'x'.repeat(16 * 1024 * 1024 + 1);
    await writeFile(file, JSON.stringify(ledger), 'utf8');
    expect(await store.getApplication('rec_leave_1')).not.toBeNull();
    expect((store as any).ledgerReadCache).toBeNull();
  });

  it('prevents starvation of due detail tasks by repeatedly failing routing tasks', async () => {
    await store.enqueueTask({ businessKey: 'starved-detail', recordId: 'rec_leave_1', kind: 'sync_leave_shift_details' });
    await store.acceptApplication(application());
    const anchor = Date.now() + 1000;
    for (let index = 0; index < 4; index++) {
      const now = anchor + index * 60_000, task = (await store.takeNextTask(now))!;
      expect(task.kind).toBe('route_application');
      await store.rescheduleTask(task.key, task.claimToken, new Error('synthetic retry'), now);
    }
    await expect(store.takeNextTask(anchor + 4 * 60_000)).resolves.toMatchObject({ kind: 'sync_leave_shift_details' });
  });

  it('keeps new stage card convergence urgent when the fairness quota is exhausted', async () => {
    await store.enqueueTask({ businessKey: 'quota-detail', recordId: 'rec_leave_1', kind: 'sync_leave_shift_details' });
    await store.acceptApplication(application());
    const anchor = Date.now() + 1000;
    for (let index = 0; index < 4; index++) {
      const now = anchor + index * 60_000, task = (await store.takeNextTask(now))!;
      await store.rescheduleTask(task.key, task.claimToken, new Error('synthetic retry'), now);
    }
    await store.enqueueTask({ businessKey: 'urgent-card', recordId: 'rec_leave_1', kind: 'sync_stage_action_cards', payload: { recovery: false } });
    await expect(store.takeNextTask(anchor + 4 * 60_000)).resolves.toMatchObject({ businessKey: 'urgent-card' });
  });

  it('does not let historical recovery repair outrank current business detail work', async () => {
    await store.enqueueTask({ businessKey: 'historical-card', recordId: 'rec_leave_1', kind: 'sync_stage_action_cards', payload: { recovery: true } });
    await store.enqueueTask({ businessKey: 'current-detail', recordId: 'rec_leave_1', kind: 'sync_leave_shift_details' });
    await expect(store.takeNextTask(Date.now() + 1000)).resolves.toMatchObject({ businessKey: 'current-detail' });
  });

  it('does not consume the fairness quota when durable task claiming fails', async () => {
    await store.enqueueTask({ businessKey: 'failure-detail', recordId: 'rec_leave_1', kind: 'sync_leave_shift_details' });
    await store.acceptApplication(application());
    const anchor = Date.now() + 1000;
    for (let index = 0; index < 3; index++) {
      const now = anchor + index * 60_000, task = (await store.takeNextTask(now))!;
      await store.rescheduleTask(task.key, task.claimToken, new Error('synthetic retry'), now);
    }
    const rename = jest.spyOn(require('node:fs/promises'), 'rename').mockRejectedValue(new Error('synthetic persist failure'));
    await expect(store.takeNextTask(anchor + 3 * 60_000)).rejects.toThrow('synthetic persist failure');
    rename.mockRestore();
    await expect(store.takeNextTask(anchor + 3 * 60_000)).resolves.toMatchObject({ kind: 'route_application' });
  });

  it('bounds normalization retention and does not cache historical timestamp fallback', async () => {
    await store.acceptApplication(application());
    const file = join(directory, 'ledger.json'), ledger = JSON.parse(await readFile(file, 'utf8'));
    const entry = ledger.applications[0];
    ledger.applications = Array.from({ length: 300 }, (_, index) => ({ ...entry, recordId: `rec_cache_${index}` }));
    await writeFile(file, JSON.stringify(ledger), 'utf8');
    await store.listApplications();
    const cache = store as unknown as { normalizedApplications: Map<string, unknown>; normalizationCacheCharacters: number };
    expect(cache.normalizedApplications.size).toBeLessThanOrEqual(256);
    expect(cache.normalizationCacheCharacters).toBeLessThanOrEqual(16 * 1024 * 1024);
    delete entry.createdAt; delete entry.updatedAt;
    ledger.applications = [entry]; await writeFile(file, JSON.stringify(ledger), 'utf8');
    const iso = jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-22T01:00:00.000Z');
    expect((await store.getApplication(entry.recordId))!.createdAt).toBe('2026-10-22T01:00:00.000Z');
    iso.mockReturnValue('2026-10-22T02:00:00.000Z');
    expect((await store.getApplication(entry.recordId))!.createdAt).toBe('2026-10-22T02:00:00.000Z');
  });

  it('keeps concurrent task claims distinct with normalization reuse', async () => {
    await store.acceptApplication(application());
    await store.enqueueTask({ businessKey: 'concurrent-detail', recordId: 'rec_leave_1', kind: 'sync_leave_shift_details' });
    const now = Date.now() + 1000;
    const tasks = await Promise.all([store.takeNextTask(now), store.takeNextTask(now)]);
    expect(new Set(tasks.map(task => task!.key)).size).toBe(2);
    expect(new Set(tasks.map(task => task!.claimToken)).size).toBe(2);
    expect(await store.takeNextTask(now)).toBeNull();
  });

  it('caps initial routing retry delays at thirty seconds rather than minutes', async () => {
    await store.acceptApplication(application());
    let timestamp = Date.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      const task = await store.takeNextTask(timestamp);
      expect(task).not.toBeNull();
      await store.rescheduleTask(task!.key, task!.claimToken, new Error('timeout of 15000ms exceeded'), timestamp);
      const pending = (await store.listTasks()).find(item => item.key === task!.key)!;
      expect(Date.parse(pending.nextAttemptAt) - timestamp).toBeLessThanOrEqual(30_000);
      timestamp = Date.parse(pending.nextAttemptAt) + 1;
    }
  });

  it('recovers temporary Windows EPERM rename without losing or duplicating acceptance', async () => {
    const filesystem = require('node:fs/promises');
    const original = filesystem.rename;
    const rename = jest.spyOn(filesystem, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('temporary file busy'), { code: 'EPERM' }))
      .mockRejectedValueOnce(Object.assign(new Error('temporary file busy'), { code: 'EBUSY' }))
      .mockImplementation(original);
    await expect(store.acceptApplication(application())).resolves.toMatchObject({ created: true });
    expect(rename).toHaveBeenCalledTimes(3);
    await expect(store.acceptApplication(application())).resolves.toMatchObject({ created: false });
    expect((await store.listTasks()).filter(task => task.kind === 'route_application')).toHaveLength(1);
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves the original ledger and removes its own temporary file after persistent rename failure', async () => {
    await store.acceptApplication(application());
    const applicationBefore = await store.getApplication('rec_leave_1');
    const before = await readFile(join(directory, 'ledger.json'), 'utf8');
    jest.spyOn(require('node:fs/promises'), 'rename').mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EPERM' }));
    await expect(store.acceptApplication({ ...application(), recordId: 'rec_leave_other', clientMutationId: 'other' })).rejects.toThrow('access denied');
    expect(await readFile(join(directory, 'ledger.json'), 'utf8')).toBe(before);
    expect(await store.getApplication('rec_leave_1')).toEqual(applicationBefore);
    expect(await store.getApplication('rec_leave_other')).toBeNull();
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('accepts one formal application for repeated client mutations', async () => {
    const first = await store.acceptApplication(application());
    const retry = await store.acceptApplication(application());

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.entry.key).toBe(first.entry.key);
    expect(retry.entry.status).toBe('accepted');
  });

  it('durably queues routing before reporting a new application as accepted', async () => {
    await store.acceptApplication(application());

    await expect(store.listTasks()).resolves.toEqual([
      expect.objectContaining({
        businessKey: 'leave:rec_leave_1:route',
        kind: 'route_application',
        recordId: 'rec_leave_1',
        status: 'pending',
      }),
    ]);
  });

  it('atomically suspends an obsolete stage and queues one durable reroute repair', async () => {
    await store.acceptApplication({
      ...application(),
      snapshot: {
        ...application().snapshot,
        applicantName: '张华',
        applicantOpenId: 'ou_station_chief',
        position: '110站站长',
        building: '110站',
      },
    });
    await store.setPendingStage('rec_leave_1', {
      key: 'manager',
      version: 1,
      approverOpenIds: ['ou_wrong_manager'],
    });

    const first = await store.schedulePendingStageReroute({
      recordId: 'rec_leave_1',
      expectedStage: {
        key: 'manager',
        version: 1,
        approverOpenIds: ['ou_wrong_manager'],
      },
      businessKey: 'leave:rec_leave_1:repair:110-station-chief:v1',
    });
    const retry = await store.schedulePendingStageReroute({
      recordId: 'rec_leave_1',
      expectedStage: {
        key: 'manager',
        version: 1,
        approverOpenIds: ['ou_wrong_manager'],
      },
      businessKey: 'leave:rec_leave_1:repair:110-station-chief:v1',
    });

    expect(first).toMatchObject({
      scheduled: true,
      entry: { status: 'routing_failed', currentStage: null },
    });
    expect(retry).toMatchObject({
      scheduled: false,
      entry: { status: 'routing_failed', currentStage: null },
    });
    const repairs = (await store.listTasks()).filter(
      (task) => task.kind === 'repair_station_chief_route',
    );
    expect(repairs).toEqual([
      expect.objectContaining({
        businessKey: 'leave:rec_leave_1:repair:110-station-chief:v1',
        payload: {
          sourceStageKey: 'manager',
          sourceStageVersion: 1,
          sourceApproverOpenIds: ['ou_wrong_manager'],
        },
      }),
    ]);
  });

  it('atomically completes a suspended reroute and queues the new stage once', async () => {
    const reroutedPlan = {
      approvalClass: 'ordinary' as const,
      discipline: null,
      approvalDayCount: 1,
      stages: [
        {
          key: 'supervisor' as const,
          approvers: [
            {
              name: '周海祥',
              openId: 'ou_station_supervisor',
              position: '电气主管',
              buildings: ['110站'],
            },
          ],
          resolutionPolicy: 'first_legal_action' as const,
        },
      ],
      notificationPlan: {
        finalResultRecipients: [],
        professionalRecipients: [],
        substituteRecipients: [],
      },
    };
    await store.acceptApplication(application());
    await store.setPendingStage('rec_leave_1', {
      key: 'manager',
      version: 1,
      approverOpenIds: ['ou_wrong_manager'],
    });
    await store.schedulePendingStageReroute({
      recordId: 'rec_leave_1',
      expectedStage: {
        key: 'manager',
        version: 1,
        approverOpenIds: ['ou_wrong_manager'],
      },
      businessKey: 'leave:rec_leave_1:repair:110-station-chief:v1',
    });

    await store.completePendingStageReroute('rec_leave_1', {
      approvalPlan: reroutedPlan,
      resultRecipients: reroutedPlan.stages[0].approvers,
      stage: {
        key: 'supervisor',
        version: 2,
        approverOpenIds: ['ou_station_supervisor'],
      },
    });
    await store.completePendingStageReroute('rec_leave_1', {
      approvalPlan: reroutedPlan,
      resultRecipients: reroutedPlan.stages[0].approvers,
      stage: {
        key: 'supervisor',
        version: 2,
        approverOpenIds: ['ou_station_supervisor'],
      },
    });

    await expect(store.getApplication('rec_leave_1')).resolves.toMatchObject({
      status: 'supervisor_pending',
      currentStage: {
        key: 'supervisor',
        version: 2,
        approverOpenIds: ['ou_station_supervisor'],
      },
    });
    const deliveries = (await store.listTasks()).filter(
      (task) => task.businessKey === 'leave:rec_leave_1:deliver:supervisor:2',
    );
    expect(deliveries).toHaveLength(1);
  });

  it('normalizes and persists reusable leave screenshot image keys', async () => {
    await store.acceptApplication({
      ...application(),
      snapshot: {
        ...application().snapshot,
        screenshotImageKeys: [
          'img_v3_leave_evidence_1',
          'img_v3_leave_evidence_1',
          'invalid key',
        ],
        screenshotStatus: 'ready',
      },
    });

    await expect(store.getApplication('rec_leave_1')).resolves.toMatchObject({
      snapshot: {
        screenshotImageKeys: ['img_v3_leave_evidence_1'],
        screenshotStatus: 'ready',
      },
    });
  });

  it('atomically recovers an expired task lease before claiming more work', async () => {
    await store.acceptApplication(application());
    const now = new Date();
    const first = await store.takeNextTask(now, 1_000);
    const recovered = await store.takeNextTask(
      new Date(now.getTime() + 2_000),
      1_000,
    );

    expect(first).toMatchObject({
      businessKey: 'leave:rec_leave_1:route',
      attempts: 1,
      status: 'processing',
    });
    expect(recovered).toMatchObject({
      businessKey: 'leave:rec_leave_1:route',
      attempts: 2,
      status: 'processing',
    });
    expect(recovered?.claimToken).not.toBe(first?.claimToken);
  });

  it('wakes persisted pending tasks immediately during startup recovery', async () => {
    await store.acceptApplication(application());
    const now = new Date();
    const first = await store.takeNextTask(now);
    if (!first) throw new Error('expected routing task');
    await store.rescheduleTask(
      first.key,
      first.claimToken,
      new Error('temporary route failure'),
      now,
    );
    const beforeBackoff = new Date(now.getTime() + 500);

    await expect(store.takeNextTask(beforeBackoff)).resolves.toBeNull();
    await expect(store.wakePendingTasks(beforeBackoff)).resolves.toBe(1);
    await expect(store.takeNextTask(beforeBackoff)).resolves.toMatchObject({
      businessKey: 'leave:rec_leave_1:route',
      status: 'processing',
      attempts: 2,
    });
  });

  it('allows only the first legal action for the current approval stage', async () => {
    await store.acceptApplication(application());
    await store.setPendingStage('rec_leave_1', {
      key: 'supervisor',
      version: 1,
      approverOpenIds: ['ou_supervisor', 'ou_backup'],
    });

    const [first, second] = await Promise.all([
      store.claimStageAction({
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor',
        action: 'approve',
        eventId: 'evt_1',
      }),
      store.claimStageAction({
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_backup',
        action: 'reject',
        rejectionReason: '排班保障不足',
        eventId: 'evt_2',
      }),
    ]);

    expect([first.accepted, second.accepted].filter(Boolean)).toHaveLength(1);
    expect([first.reason, second.reason]).toContain('already_processed');
  });

  it('merges legacy stage-card message ids before accepting an approval callback', async () => {
    const primaryPath = join(directory, 'persistent', 'ledger.json');
    const legacyPath = join(directory, 'legacy', 'ledger.json');
    const primaryStore = new LeaveWorkflowStore(primaryPath);
    const legacyStore = new LeaveWorkflowStore(legacyPath);

    for (const candidate of [primaryStore, legacyStore]) {
      await candidate.acceptApplication(application());
      await candidate.setPendingStage('rec_leave_1', {
        key: 'supervisor',
        version: 1,
        approverOpenIds: ['ou_supervisor'],
      });
    }
    await primaryStore.recordStageCardDelivery('rec_leave_1', {
      recipientOpenId: 'ou_supervisor',
      messageId: 'om_primary_card',
      businessKey: 'leave:rec_leave_1:supervisor:1:ou_supervisor',
    });
    await legacyStore.recordStageCardDelivery('rec_leave_1', {
      recipientOpenId: 'ou_supervisor',
      messageId: 'om_legacy_card',
      businessKey: 'leave:rec_leave_1:supervisor:1:ou_supervisor',
    });

    const recovered = new LeaveWorkflowStore(primaryPath, legacyPath);
    await recovered.onModuleInit(new Date('2026-08-31T08:30:00.000Z'));

    await expect(
      recovered.getApplication('rec_leave_1'),
    ).resolves.toMatchObject({
      stageCards: expect.arrayContaining([
        expect.objectContaining({ messageId: 'om_primary_card' }),
        expect.objectContaining({ messageId: 'om_legacy_card' }),
      ]),
    });
    await expect(
      recovered.claimStageAction({
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor',
        action: 'approve',
        eventId: 'evt_from_legacy_card',
        messageId: 'om_legacy_card',
      }),
    ).resolves.toMatchObject({ accepted: true, reason: 'accepted' });

    const restarted = new LeaveWorkflowStore(primaryPath, legacyPath);
    await restarted.onModuleInit(new Date('2026-08-31T08:31:00.000Z'));
    await expect(
      restarted.getApplication('rec_leave_1'),
    ).resolves.toMatchObject({
      stageCards: expect.arrayContaining([
        expect.objectContaining({ messageId: 'om_primary_card' }),
        expect.objectContaining({ messageId: 'om_legacy_card' }),
      ]),
    });
    expect(
      (await restarted.getApplication('rec_leave_1'))?.stageCards,
    ).toHaveLength(2);
  });

  it('requires and atomically persists the rejection reason', async () => {
    await store.acceptApplication(application());
    await store.setPendingStage('rec_leave_1', {
      key: 'supervisor',
      version: 1,
      approverOpenIds: ['ou_supervisor'],
    });

    await expect(
      store.claimStageAction({
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor',
        action: 'reject',
        eventId: 'evt_reject_missing_reason',
      }),
    ).rejects.toThrow('请填写驳回原因');

    await expect(
      store.claimStageAction({
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor',
        action: 'reject',
        rejectionReason: '当日保障力量不足',
        eventId: 'evt_reject_with_reason',
      }),
    ).resolves.toMatchObject({
      accepted: true,
      action: { rejectionReason: '当日保障力量不足' },
      entry: { rejectionReason: '当日保障力量不足' },
    });
  });

  it('atomically versions a post-approval substitute adjustment', async () => {
    await store.acceptApplication({
      ...application(),
      snapshot: {
        ...application().snapshot,
        substituteRequired: true,
        substitutePersonRecordId: 'rec_substitute_old',
        substituteOpenId: 'ou_substitute_old',
        substituteName: '李四',
        substituteRevision: 0,
        substituteCandidates: [
          {
            personRecordId: 'rec_substitute_old',
            name: '李四',
            openId: 'ou_substitute_old',
            position: '长白',
            buildings: ['D楼'],
          },
          {
            personRecordId: 'rec_substitute_new',
            name: '王五',
            openId: '',
            position: '实习生（备岗）',
            buildings: ['E楼'],
          },
        ],
      },
    });
    await store.setApprovalPlan('rec_leave_1', {
      snapshot: {
        ...application().snapshot,
        substituteRequired: true,
        substitutePersonRecordId: 'rec_substitute_old',
        substituteOpenId: 'ou_substitute_old',
        substituteName: '李四',
        substituteRevision: 0,
        substituteCandidates: [
          {
            personRecordId: 'rec_substitute_old',
            name: '李四',
            openId: 'ou_substitute_old',
            position: '长白',
            buildings: ['D楼'],
          },
          {
            personRecordId: 'rec_substitute_new',
            name: '王五',
            openId: '',
            position: '实习生（备岗）',
            buildings: ['E楼'],
          },
        ],
      },
      approvalPlan: {
        approvalClass: 'ordinary',
        discipline: null,
        approvalDayCount: 1,
        stages: [
          {
            key: 'supervisor',
            approvers: [
              {
                name: '主管',
                openId: 'ou_supervisor',
                position: '设施运维主管',
                buildings: ['D楼'],
              },
            ],
          },
        ],
        notificationPlan: {
          finalResultRecipients: [],
          professionalRecipients: [],
          substituteRecipients: [],
        },
      },
      resultRecipients: [],
    });
    await store.patchApplication('rec_leave_1', { status: 'approved' });

    const accepted = await store.claimSubstituteUpdate({
      eventId: 'evt_substitute_update_1',
      recordId: 'rec_leave_1',
      expectedRevision: 0,
      actorOpenId: 'ou_supervisor',
      actorName: '主管',
      messageId: '',
      substitutePersonRecordId: 'rec_substitute_new',
    });
    const stale = await store.claimSubstituteUpdate({
      eventId: 'evt_substitute_update_2',
      recordId: 'rec_leave_1',
      expectedRevision: 0,
      actorOpenId: 'ou_supervisor',
      actorName: '主管',
      messageId: '',
      substitutePersonRecordId: 'rec_substitute_old',
    });

    expect(accepted).toMatchObject({
      accepted: true,
      entry: {
        snapshot: {
          substitutePersonRecordId: 'rec_substitute_new',
          substituteName: '王五',
          substituteRevision: 1,
          substituteUpdatedByOpenId: 'ou_supervisor',
        },
      },
      update: { previousSubstituteName: '李四', substituteName: '王五' },
    });
    expect(stale).toMatchObject({ accepted: false, reason: 'stale_revision' });
    await expect(store.listTasks()).resolves.toContainEqual(
      expect.objectContaining({
        businessKey: 'leave:rec_leave_1:substitute-update:1',
        kind: 'apply_substitute_update',
      }),
    );
  });

  it('allows a second-stage manager decision after a supervisor approval', async () => {
    await store.acceptApplication(application());
    await store.setPendingStage('rec_leave_1', {
      key: 'supervisor',
      version: 1,
      approverOpenIds: ['ou_supervisor'],
    });
    await store.claimStageAction({
      recordId: 'rec_leave_1',
      stageKey: 'supervisor',
      stageVersion: 1,
      actorOpenId: 'ou_supervisor',
      action: 'approve',
      eventId: 'evt_supervisor',
    });
    await store.setPendingStage('rec_leave_1', {
      key: 'manager',
      version: 2,
      approverOpenIds: ['ou_manager'],
    });

    const decision = await store.claimStageAction({
      recordId: 'rec_leave_1',
      stageKey: 'manager',
      stageVersion: 2,
      actorOpenId: 'ou_manager',
      action: 'approve',
      eventId: 'evt_manager',
    });

    expect(decision).toMatchObject({ accepted: true, reason: 'accepted' });
    await expect(store.listTasks()).resolves.toContainEqual(
      expect.objectContaining({
        businessKey: 'leave:rec_leave_1:apply:supervisor:1',
        kind: 'apply_stage_action',
        status: 'pending',
      }),
    );
  });

  it('atomically requires and persists a legal substitute on supervisor approval', async () => {
    await store.acceptApplication({
      ...application(),
      snapshot: {
        ...application().snapshot,
        substituteRequired: true,
        substituteCandidates: [
          {
            personRecordId: 'rec_substitute',
            name: '李四',
            openId: 'ou_substitute',
            position: '实习生（备岗）',
            buildings: ['D楼'],
          },
        ],
      },
    });
    await store.setPendingStage('rec_leave_1', {
      key: 'supervisor',
      version: 1,
      approverOpenIds: ['ou_supervisor'],
    });

    await expect(
      store.claimStageAction({
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor',
        action: 'approve',
        eventId: 'evt_missing_substitute',
      }),
    ).rejects.toThrow('请选择替班人员');
    await expect(
      store.claimStageAction({
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor',
        action: 'approve',
        eventId: 'evt_forged_substitute',
        substitutePersonRecordId: 'rec_not_eligible',
      }),
    ).rejects.toThrow('所选替班人员不在当前可用人员清单中');

    const result = await store.claimStageAction({
      recordId: 'rec_leave_1',
      stageKey: 'supervisor',
      stageVersion: 1,
      actorOpenId: 'ou_supervisor',
      action: 'approve',
      eventId: 'evt_valid_substitute',
      substitutePersonRecordId: 'rec_substitute',
    });

    expect(result).toMatchObject({
      accepted: true,
      action: {
        substitutePersonRecordId: 'rec_substitute',
        substituteName: '李四',
      },
      entry: {
        snapshot: {
          substituteOpenId: 'ou_substitute',
          substitutePersonRecordId: 'rec_substitute',
          substituteName: '李四',
        },
        resultRecipients: [
          expect.objectContaining({ openId: 'ou_substitute' }),
        ],
      },
    });
  });

  it('atomically persists the complete per-shift assignment set on approval', async () => {
    const multiShift = multiShiftApplication();
    await store.acceptApplication(multiShift);
    await store.setPendingStage('rec_leave_1', {
      key: 'supervisor',
      version: 1,
      approverOpenIds: ['ou_supervisor'],
    });

    const result = await store.claimStageAction({
      recordId: 'rec_leave_1',
      stageKey: 'supervisor',
      stageVersion: 1,
      actorOpenId: 'ou_supervisor',
      actorName: '主管',
      action: 'approve',
      eventId: 'evt_multi_shift_approve',
      shiftAssignments: multiShift.snapshot.shiftGroups.map((group, index) =>
        assignment(group, index === 0 ? substituteZhang : substituteLi),
      ),
    });

    expect(result).toMatchObject({
      accepted: true,
      action: {
        previousShiftAssignments: [],
        shiftAssignments: [
          { shiftKey: multiShift.snapshot.shiftGroups[0].shiftKey },
          { shiftKey: multiShift.snapshot.shiftGroups[1].shiftKey },
        ],
      },
      entry: {
        snapshot: {
          assignmentRevision: 0,
          shiftAssignments: [
            { substitutePersonRecordId: 'rec_zhang' },
            { substitutePersonRecordId: 'rec_li' },
          ],
        },
      },
    });
  });

  it('requires a substitute decision for an undecided long-white approval', async () => {
    const optional = longWhiteDecisionApplication();
    await store.acceptApplication(optional);
    await store.setPendingStage('rec_leave_1', {
      key: 'supervisor',
      version: 1,
      approverOpenIds: ['ou_supervisor'],
    });

    await expect(
      store.claimStageAction({
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor',
        actorName: '主管',
        action: 'approve',
        eventId: 'evt_long_white_missing_decision',
      }),
    ).rejects.toThrow('请选择是否需要替班');
  });

  it('atomically persists no-substitute and clears stale substitute data', async () => {
    const optional = longWhiteDecisionApplication();
    const staleAssignment = assignment(
      optional.snapshot.shiftGroups[0],
      substituteZhang,
    );
    await store.acceptApplication({
      ...optional,
      snapshot: {
        ...optional.snapshot,
        substituteRequired: true,
        substitutePersonRecordId: substituteZhang.personRecordId,
        substituteOpenId: substituteZhang.openId,
        substituteName: substituteZhang.name,
        shiftAssignments: [staleAssignment],
      },
    });
    await store.setPendingStage('rec_leave_1', {
      key: 'supervisor',
      version: 1,
      approverOpenIds: ['ou_supervisor'],
    });

    const result = await store.claimStageAction({
      recordId: 'rec_leave_1',
      stageKey: 'supervisor',
      stageVersion: 1,
      actorOpenId: 'ou_supervisor',
      actorName: '主管',
      action: 'approve',
      eventId: 'evt_long_white_no_substitute',
      substituteRequired: false,
    });

    expect(result.action).toMatchObject({ substituteRequired: false });
    expect(result.entry.snapshot).toMatchObject({
      substituteDecisionRequired: true,
      substituteDecisionMade: true,
      substituteRequired: false,
      shiftAssignments: [],
    });
    expect(result.entry.snapshot.substitutePersonRecordId).toBeUndefined();
    expect(result.entry.snapshot.substituteOpenId).toBeUndefined();
    expect(result.entry.snapshot.substituteName).toBeUndefined();
  });

  it('accepts only one concurrent aggregate assignment revision', async () => {
    const multiShift = multiShiftApplication();
    const initialAssignments = multiShift.snapshot.shiftGroups.map(
      (group, index) =>
        assignment(group, index === 0 ? substituteZhang : substituteLi),
    );
    await store.acceptApplication({
      ...multiShift,
      snapshot: {
        ...multiShift.snapshot,
        shiftAssignments: initialAssignments,
      },
    });
    await store.setApprovalPlan('rec_leave_1', {
      snapshot: {
        ...multiShift.snapshot,
        shiftAssignments: initialAssignments,
      },
      approvalPlan: {
        approvalClass: 'ordinary',
        discipline: null,
        approvalDayCount: 1,
        stages: [
          {
            key: 'supervisor',
            approvers: [
              {
                name: '主管',
                openId: 'ou_supervisor',
                position: '设施运维主管',
                buildings: ['A楼'],
              },
            ],
          },
        ],
        notificationPlan: {
          finalResultRecipients: [],
          professionalRecipients: [],
          substituteRecipients: [],
        },
      },
      resultRecipients: [],
    });
    await store.patchApplication('rec_leave_1', { status: 'approved' });
    const swapped = multiShift.snapshot.shiftGroups.map((group, index) =>
      assignment(group, index === 0 ? substituteLi : substituteZhang),
    );

    const decisions = await Promise.all([
      store.claimSubstituteUpdate({
        eventId: 'evt_multi_update_1',
        recordId: 'rec_leave_1',
        expectedRevision: 0,
        actorOpenId: 'ou_supervisor',
        actorName: '主管',
        shiftAssignments: swapped,
      }),
      store.claimSubstituteUpdate({
        eventId: 'evt_multi_update_2',
        recordId: 'rec_leave_1',
        expectedRevision: 0,
        actorOpenId: 'ou_supervisor',
        actorName: '主管',
        shiftAssignments: initialAssignments,
      }),
    ]);

    expect(decisions.filter((decision) => decision.accepted)).toHaveLength(1);
    expect(decisions.map((decision) => decision.reason)).toContain(
      'stale_revision',
    );
    expect(decisions.find((decision) => decision.accepted)).toMatchObject({
      update: {
        expectedRevision: 0,
        revision: 1,
        previousShiftAssignments: initialAssignments,
        shiftAssignments: swapped.map((item) =>
          expect.objectContaining({
            shiftKey: item.shiftKey,
            substitutePersonRecordId: item.substitutePersonRecordId,
          }),
        ),
        changedShiftKeys: multiShift.snapshot.shiftGroups.map(
          (group) => group.shiftKey,
        ),
      },
    });
  });

  it('loads a legacy version 3 ledger with empty assignment defaults', async () => {
    await store.acceptApplication(application());
    const ledgerPath = join(directory, 'ledger.json');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      version: number;
      applications: Array<{ snapshot: Record<string, unknown> }>;
    };
    ledger.version = 3;
    delete ledger.applications[0].snapshot.shiftGroups;
    delete ledger.applications[0].snapshot.candidateSets;
    delete ledger.applications[0].snapshot.shiftAssignments;
    delete ledger.applications[0].snapshot.assignmentRevision;
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');

    store = new LeaveWorkflowStore(ledgerPath);
    await expect(store.getApplication('rec_leave_1')).resolves.toMatchObject({
      snapshot: {
        shiftGroups: [],
        candidateSets: [],
        shiftAssignments: [],
        assignmentRevision: 0,
      },
    });
  });
});

const substituteZhang = {
  personRecordId: 'rec_zhang',
  name: '张三',
  openId: 'ou_zhang',
  position: '运维值班员',
  buildings: ['A楼'],
};

const substituteLi = {
  personRecordId: 'rec_li',
  name: '李四',
  openId: 'ou_li',
  position: '运维值班员',
  buildings: ['B楼'],
};

function assignment(
  group: ReturnType<
    typeof multiShiftApplication
  >['snapshot']['shiftGroups'][number],
  substitute: typeof substituteZhang,
) {
  return {
    shiftKey: group.shiftKey,
    scheduleRecordIds: [...group.scheduleRecordIds],
    scheduleDate: group.scheduleDate,
    startAt: group.startAt,
    endAt: group.endAt,
    shift: group.shift,
    buildings: [...group.buildings],
    teams: [...group.teams],
    substitutePersonRecordId: substitute.personRecordId,
    substituteName: substitute.name,
    substituteOpenId: substitute.openId,
    updatedByOpenId: 'ou_supervisor',
    updatedByName: '主管',
    updatedAt: '2026-08-25T10:00:00.000Z',
  };
}

function multiShiftApplication() {
  const shiftGroups = [
    {
      shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
      scheduleDate: '2026-08-26',
      startAt: '2026-08-26T09:00',
      endAt: '2026-08-26T18:00',
      kind: 'white' as const,
      shift: '白班',
      buildings: ['A楼'],
      teams: ['一班'],
      scheduleRecordIds: ['schedule_1'],
      leaveHours: 8,
    },
    {
      shiftKey: '2026-08-27T18:00__2026-08-28T09:00',
      scheduleDate: '2026-08-27',
      startAt: '2026-08-27T18:00',
      endAt: '2026-08-28T09:00',
      kind: 'night' as const,
      shift: '夜班',
      buildings: ['B楼'],
      teams: ['二班'],
      scheduleRecordIds: ['schedule_2'],
      leaveHours: 15,
    },
  ];
  return {
    ...application(),
    snapshot: {
      ...application().snapshot,
      substituteRequired: true,
      shiftGroups,
      candidateSets: shiftGroups.map((group) => ({
        shiftKey: group.shiftKey,
        candidates: [substituteZhang, substituteLi],
      })),
      shiftAssignments: [],
      assignmentRevision: 0,
    },
  };
}

function longWhiteDecisionApplication() {
  const source = multiShiftApplication();
  const shiftGroups = source.snapshot.shiftGroups.map((group) => ({
    ...group,
    kind: 'long_white' as const,
    shift: '长白班',
  }));
  return {
    ...source,
    snapshot: {
      ...source.snapshot,
      substituteRequired: false,
      substituteDecisionRequired: true,
      substituteDecisionMade: false,
      shiftGroups,
      candidateSets: shiftGroups.map((group) => ({
        shiftKey: group.shiftKey,
        candidates: [substituteZhang, substituteLi],
      })),
      shiftAssignments: [],
    },
  };
}

function application() {
  return {
    clientMutationId: 'leave-client-mutation-1',
    recordId: 'rec_leave_1',
    snapshot: {
      applicantName: '张三',
      applicantOpenId: 'ou_applicant',
      building: 'A楼',
      position: '运维值班员',
      leaveType: '年假',
      startAt: '2026-08-17T09:00:00+08:00',
      endAt: '2026-08-17T18:00:00+08:00',
      leaveHours: 8,
      approvalDayCount: 1,
      reason: '测试',
    },
  };
}
