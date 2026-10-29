import { ConflictException, Logger } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { TodayOperationsFollowUpCardService } from './today-operations-follow-up-card.service';
import { TodayOperationsFollowUpCardStore } from './today-operations-follow-up-card.store';
import type { TodayOperationsFollowUpRecord, TodayOperationsFollowUpUpdate } from './today-operations-anomaly.types';

// Tests explicitly run recovery, so delayed callbacks cannot start hidden work after assertions.
jest.mock('../../common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => false }),
}));

const appId = 'cli_followup_service', messageA = 'om_serviceA', messageB = 'om_serviceB';
const actorA = 'ou_actorA', actorB = 'ou_actorB', reader = 'ou_reader';
const summary = { schema: '2.0', header: { title: { content: '合成巡视摘要' } } };
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { assertion(); return; } catch (error) { failure = error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw failure;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function record(id = 'recA', patch: Partial<TodayOperationsFollowUpRecord> = {}): TodayOperationsFollowUpRecord {
  return { recordId: id, issueKey: `issue-${id}`, date: '2026-10-29', source: '每日巡视', item: `合成异常 ${id}`,
    description: '仅用于本地隔离测试', building: 'A楼', acknowledged: false, completed: false,
    treatmentMeasure: '', handlerName: '', handledAt: '', ...patch };
}
function envelope(action: unknown, actorOpenId = actorA, messageId = messageA) {
  return { event_type: 'card.action.trigger', event_id: 'synthetic-event', operator: { open_id: actorOpenId },
    context: { open_message_id: messageId }, action };
}
function view(batchId: string, action: 'list' | 'summary' | 'edit' = 'edit', position = 0, actorOpenId = actorA, messageId = messageA) {
  return envelope({ tag: 'button', value: { workflowType: 'today_operations_followup', version: 1, batchId, action,
    ...(action === 'list' ? { page: position } : action === 'edit' ? { index: position } : {}) } }, actorOpenId, messageId);
}
function submit(batchId: string, options: { index?: number; revision?: number; actor?: string; message?: string; measure?: string; status?: string } = {}) {
  return envelope({ tag: 'button', name: `today_followup_submit:${batchId}:${options.index ?? 0}:${options.revision ?? 1}`,
    form_value: { follow_up_status: options.status || 'completed', follow_up_measure: options.measure || '已完成合成检查' } },
  options.actor || actorA, options.message || messageA);
}

describe('TodayOperationsFollowUpCardService', () => {
  const savedAppId = process.env.FEISHU_APP_ID;
  let directory: string, file: string, store: TodayOperationsFollowUpCardStore, service: TodayOperationsFollowUpCardService;
  let db: Map<string, TodayOperationsFollowUpRecord>, enabled: boolean, roles: Map<string, string>;
  let gateway: { getFollowUp: jest.Mock; updateFollowUp: jest.Mock; patchInteractiveCard: jest.Mock };
  let configuration: { canUseFeishuBusinessIdentity: jest.Mock; feishuPrincipal: jest.Mock; pagePermissions: jest.Mock };
  beforeEach(async () => {
    process.env.FEISHU_APP_ID = appId;
    directory = await mkdtemp(join(tmpdir(), 'followup-card-service-'));
    file = join(directory, 'ledger.json');
    store = new TodayOperationsFollowUpCardStore(file);
    db = new Map([['recA', record()], ['recB', record('recB')]]);
    enabled = true;
    roles = new Map([[actorA, 'editor'], [actorB, 'editor'], [reader, 'building_admin']]);
    gateway = {
      getFollowUp: jest.fn(async (id: string) => {
        const value = db.get(id); if (!value) throw new Error('Synthetic record is missing');
        return structuredClone(value);
      }),
      updateFollowUp: jest.fn(async (input: TodayOperationsFollowUpUpdate) => {
        const next = { ...db.get(input.recordId)!, acknowledged: input.acknowledged || input.completed,
          completed: input.completed, treatmentMeasure: input.treatmentMeasure,
          handlerName: input.handlerName || '', handledAt: new Date().toISOString() };
        db.set(input.recordId, next);
        return structuredClone(next);
      }),
      patchInteractiveCard: jest.fn(async () => undefined),
    };
    configuration = {
      canUseFeishuBusinessIdentity: jest.fn(() => enabled),
      feishuPrincipal: jest.fn((id: string) => roles.has(id)
        ? { role: roles.get(id), purchaseBuilding: null, accountId: `synthetic-${id}`, displayName: id === actorA ? '测试甲' : '测试乙' } : null),
      pagePermissions: jest.fn(() => ({ paths: ['/today-operations-panorama'], configured: true, revision: 1 })),
    };
    service = new TodayOperationsFollowUpCardService(store, gateway as never, configuration as never);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    service.onModuleDestroy();
    await immediate();
    jest.restoreAllMocks();
    if (savedAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = savedAppId;
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep + 'followup-card-service-')) throw new Error('Unsafe isolated cleanup path');
    await rm(target, { recursive: true, force: true });
  });
  async function prepare(ids = ['recA', 'recB'], editing = true) {
    const id = await service.prepare(ids, 'daily-2026-10-29');
    await service.bindMessage(id, messageA, summary);
    if (editing) await store.setView(id, messageA, { kind: 'edit', index: 0 });
    return id;
  }

  it('prepares and binds a stable batch without resetting revisions or emitting a message', async () => {
    const id = await prepare(['recB', 'recA', 'recA']);
    expect(await service.prepare(['recA', 'recB'], 'daily-2026-10-29')).toBe(id);
    await service.bindMessage(id, messageA, summary);
    const snapshot = await store.getSnapshot(id, messageA);
    expect(snapshot.batch.recordIds).toEqual(['recA', 'recB']);
    expect(snapshot.records.map(row => row.revision)).toEqual([1, 1]);
    expect(snapshot.message?.view).toEqual({ kind: 'edit', index: 0 });
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
  });

  it.each(['message', 'batch', 'index', 'app'] as const)('rejects a forged %s binding before starting work', async kind => {
    const id = await prepare();
    if (kind === 'app') process.env.FEISHU_APP_ID = 'cli_other';
    const payload = view(kind === 'batch' ? 'f'.repeat(32) : id, 'edit', kind === 'index' ? 999 : 0,
      actorA, kind === 'message' ? 'om_unknown' : messageA);
    await expect(service.handle(payload)).rejects.toThrow();
    await immediate();
    expect(await store.pendingCommands()).toEqual([]);
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'unknown', 'revoked', 'reader'] as const)('rejects %s users before a business claim', async kind => {
    const id = await prepare();
    if (kind === 'inactive') enabled = false;
    if (kind === 'unknown') roles.delete(actorA);
    if (kind === 'revoked') roles.set(actorA, 'guest');
    await expect(service.handle(submit(id, { actor: kind === 'reader' ? reader : actorA }))).rejects.toThrow();
    expect(await store.pendingCommands()).toEqual([]);
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses current personal permissions rather than the native role, explicit deny=%s', async denied => {
    const id = await prepare();
    const grant = { id: 'today-followup-allow', module: 'today_operations', actions: ['read', 'update'], effect: 'allow', buildings: null, specialties: null };
    configuration.feishuPrincipal.mockReturnValue({ role: denied ? 'editor' : 'guest', purchaseBuilding: null,
      accountId: 'synthetic-person', displayName: '自定义权限人员', effectiveAuthorization: {
        mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [grant] },
        overrides: { allowPages: [], denyPages: [], rules: denied ? [{ ...grant, id: 'today-followup-deny', actions: ['update'], effect: 'deny' }] : [] },
      } });
    if (denied) {
      await expect(service.handle(submit(id))).rejects.toThrow('暂无异常跟进权限');
      expect(await store.pendingCommands()).toEqual([]);
    } else {
      await expect(service.handle(submit(id))).resolves.toHaveProperty('card');
      expect(await store.pendingCommands()).toHaveLength(1);
    }
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
  });

  it('returns only a toast for navigation and patches the fresh form without writing a business record', async () => {
    const id = await prepare();
    db.set('recA', record('recA', { treatmentMeasure: '外部已填写' }));
    const result = await service.handle(view(id));
    expect(result.card).toBeUndefined();
    expect(result.toast.type).toBe('info');
    await eventually(() => expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1));
    const card = JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1]);
    expect(card).toContain('"tag":"form"');
    expect(card).toContain('外部已填写');
    expect(card).toContain(`today_followup_submit:${id}:0:2`);
    expect(card).not.toContain('open_url');
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
    expect(await store.pendingCommands()).toEqual([]);
  });

  it.each(['reader', 'completed'] as const)('shows %s details without an editable form', async mode => {
    if (mode === 'completed') db.set('recA', record('recA', { completed: true, acknowledged: true, treatmentMeasure: '原先已完成' }));
    const id = await prepare();
    await service.handle(view(id, 'edit', 0, mode === 'reader' ? reader : actorA));
    await eventually(() => expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1));
    const card = JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1]);
    expect(card).toContain('合成异常 recA');
    expect(card).not.toContain('"tag":"form"');
    expect(card).not.toContain('today_followup_submit:');
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
  });

  it('rechecks eligibility after a slow read before patching the editing form', async () => {
    const id = await prepare(), gate = deferred<TodayOperationsFollowUpRecord>();
    gateway.getFollowUp.mockImplementationOnce(() => gate.promise);
    gateway.getFollowUp.mockClear();
    await service.handle(view(id));
    await eventually(() => expect(gateway.getFollowUp).toHaveBeenCalledTimes(1));
    enabled = false;
    gate.resolve(record());
    await eventually(() => expect(Logger.prototype.warn).toHaveBeenCalled());
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
    expect(await store.pendingCommands()).toEqual([]);
  });

  it('discards an old slow edit view when a later navigation returns to the summary', async () => {
    const id = await prepare(), gate = deferred<TodayOperationsFollowUpRecord>();
    gateway.getFollowUp.mockImplementationOnce(() => gate.promise);
    gateway.getFollowUp.mockClear();
    await service.handle(view(id));
    await eventually(() => expect(gateway.getFollowUp).toHaveBeenCalledTimes(1));
    await service.handle(view(id, 'summary'));
    gate.resolve(record());
    await eventually(() => expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1));
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith(messageA, summary);
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
    expect((await store.getSnapshot(id, messageA)).message?.view).toEqual({ kind: 'summary' });
  });

  it('accepts one of two concurrent submissions, updates only that record and makes old submissions idempotent', async () => {
    const id = await prepare(), untouched = structuredClone(db.get('recB'));
    const results = await Promise.all([
      service.handle(submit(id, { actor: actorA, measure: '甲完成检查' })),
      service.handle(submit(id, { actor: actorB, measure: '乙完成检查' })),
    ]);
    expect(results.filter(result => result.toast.content === '跟进已受理，正在同步')).toHaveLength(1);
    expect(await store.pendingCommands()).toHaveLength(1);
    const first = service.runPendingTasks();
    expect(service.runPendingTasks()).toBe(first);
    await first;
    expect(gateway.updateFollowUp).toHaveBeenCalledTimes(1);
    expect(gateway.updateFollowUp.mock.calls[0][0]).toMatchObject({ recordId: 'recA', handlerName: '测试甲', treatmentMeasure: '甲完成检查' });
    expect(db.get('recB')).toEqual(untouched);
    expect((await store.getSnapshot(id, messageA)).records.map(row => row.record.completed)).toEqual([true, false]);
    expect(await store.pendingCommands()).toEqual([]);
    await service.handle(submit(id, { actor: actorB, measure: '旧事件不能覆盖' }));
    await service.runPendingTasks();
    expect(gateway.updateFollowUp).toHaveBeenCalledTimes(1);
    expect(db.get('recA')?.treatmentMeasure).toBe('甲完成检查');
  });

  it('persists the claim and returns a read-only processing card before slow external I/O completes', async () => {
    const id = await prepare(), gate = deferred<TodayOperationsFollowUpRecord>();
    gateway.updateFollowUp.mockImplementationOnce(() => gate.promise);
    const response = await service.handle(submit(id));
    expect(await store.pendingCommands()).toHaveLength(1);
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
    const processing = JSON.stringify(response.card);
    expect(processing).toContain('正在同步');
    expect(processing).not.toMatch(/"tag":"form"|"type":"callback"|"type":"open_url"|form_action_type/);
    const worker = service.runPendingTasks();
    await eventually(() => expect(gateway.updateFollowUp).toHaveBeenCalledTimes(1));
    await service.handle(submit(id, { actor: actorB }));
    expect(gateway.updateFollowUp).toHaveBeenCalledTimes(1);
    gate.resolve(record('recA', { completed: true, acknowledged: true, treatmentMeasure: '已完成合成检查', handlerName: '测试甲' }));
    await worker;
    expect(await store.pendingCommands()).toEqual([]);
  });

  it('recovers a failed card patch after restart without repeating the successful business write', async () => {
    const id = await prepare();
    gateway.patchInteractiveCard.mockRejectedValueOnce(new Error('synthetic patch unavailable'));
    await service.handle(submit(id));
    await service.runPendingTasks();
    const waiting = await store.pendingCommands(Number.MAX_SAFE_INTEGER);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ stage: 'written', attempts: 1 });
    const restarted = new TodayOperationsFollowUpCardStore(file);
    service = new TodayOperationsFollowUpCardService(restarted, gateway as never, configuration as never);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    await service.runPendingTasks();
    expect(gateway.updateFollowUp).toHaveBeenCalledTimes(1);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    expect(await restarted.pendingCommands(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect((await restarted.getSnapshot(id, messageA)).records[0].pendingCommandId).toBeUndefined();
  });

  it('keeps current server values and the submitted draft when a conflict rejects the write', async () => {
    const id = await prepare();
    db.set('recA', record('recA', { treatmentMeasure: '另一人已更新', acknowledged: true }));
    gateway.updateFollowUp.mockRejectedValueOnce(new ConflictException('synthetic changed revision'));
    await service.handle(submit(id, { measure: '我仍需提交的措施' }));
    await service.runPendingTasks();
    expect(db.get('recA')?.treatmentMeasure).toBe('另一人已更新');
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
    const form = JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1]);
    expect(form).toContain('"tag":"form"');
    expect(form).toContain('我仍需提交的措施');
    expect(form).toContain('记录已被更新');
    expect(form).toContain(`today_followup_submit:${id}:0:2`);
    expect(await store.pendingCommands()).toEqual([]);
    expect((await store.getSnapshot(id, messageA)).records[0].record.treatmentMeasure).toBe('另一人已更新');
  });

  it('does not replace a different record being edited on another card copy', async () => {
    const id = await prepare();
    await service.bindMessage(id, messageB, summary);
    await store.setView(id, messageB, { kind: 'edit', index: 1 });
    await service.handle(submit(id));
    await service.runPendingTasks();
    expect(gateway.patchInteractiveCard.mock.calls.map(call => call[0])).toEqual([messageA]);
    expect((await store.getSnapshot(id, messageB)).message?.view).toEqual({ kind: 'edit', index: 1 });
    expect((await store.getSnapshot(id, messageB)).records[1].record.completed).toBe(false);
    expect(await store.pendingCommands()).toEqual([]);
  });

  it.each(['written', 'conflict'] as const)('keeps the %s result when one user navigates while another copy PATCH is slow', async stage => {
    const id = await prepare(), gate = deferred<void>();
    await service.bindMessage(id, messageB, summary);
    await store.setView(id, messageB, { kind: 'edit', index: 0 });
    if (stage === 'conflict') {
      db.set('recA', record('recA', { treatmentMeasure: '另一人已更新', acknowledged: true }));
      gateway.updateFollowUp.mockRejectedValueOnce(new ConflictException('synthetic changed revision'));
    }
    gateway.patchInteractiveCard.mockImplementation(async (messageId: string) => {
      if (messageId === messageB) await gate.promise;
    });
    await service.handle(submit(id, { measure: '原提交草稿' }));
    const worker = service.runPendingTasks();
    const cardsForA = () => gateway.patchInteractiveCard.mock.calls.filter(call => call[0] === messageA);
    try {
      await eventually(() => expect(gateway.patchInteractiveCard.mock.calls.some(call => call[0] === messageB)).toBe(true));
      expect((await store.pendingCommands(Number.MAX_SAFE_INTEGER))[0].stage).toBe(stage);
      expect((await store.getSnapshot(id, messageA)).records[0].pendingCommandId).toBeTruthy();

      await service.handle(view(id, 'list', 0, actorB));
      await eventually(() => expect(cardsForA()).toHaveLength(2));
      expect(JSON.stringify(cardsForA().at(-1)![1])).not.toContain('正在同步');
      await service.handle(view(id, 'edit', 0, actorB));
      await eventually(() => expect(cardsForA()).toHaveLength(3));
      const navigated = JSON.stringify(cardsForA().at(-1)![1]);
      expect(navigated).not.toContain('正在同步');
      if (stage === 'conflict') {
        expect(navigated).toContain('"tag":"form"');
        expect(navigated).toContain('原提交草稿');
        expect(navigated).toContain('记录已被更新');
        const waiting = await service.handle(submit(id, { revision: 2, measure: '等待期间新补的草稿' }));
        expect(waiting.card).toBeUndefined();
      } else {
        expect(navigated).toContain('已处理完成');
        expect(navigated).not.toContain('"tag":"form"');
      }
      expect((await store.getSnapshot(id, messageA)).records[0].pendingCommandId).toBeTruthy();
    } finally {
      gate.resolve();
      await worker;
    }
    expect(await store.pendingCommands()).toEqual([]);
    expect(gateway.updateFollowUp).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cardsForA().at(-1)![1])).not.toContain('正在同步');
  });

  it('does not let a duplicate submission cancel a newer navigation between snapshot and claim', async () => {
    const id = await prepare(), gate = deferred<TodayOperationsFollowUpRecord>();
    await service.handle(submit(id));
    const originalClaim = store.claim.bind(store);
    gateway.getFollowUp.mockImplementationOnce(() => gate.promise);
    jest.spyOn(store, 'claim').mockImplementationOnce(async input => {
      await service.handle(view(id, 'edit', 1));
      return originalClaim(input);
    });
    try {
      const duplicate = await service.handle(submit(id));
      expect(duplicate.card).toBeUndefined();
      expect(duplicate.toast.content).toBeTruthy();
      gate.resolve(record('recB'));
      await eventually(() => expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1));
      const newerForm = JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1]);
      expect(newerForm).toContain(`today_followup_submit:${id}:1:1`);
      expect(newerForm).toContain('合成异常 recB');
      expect((await store.getSnapshot(id, messageA)).message?.view).toEqual({ kind: 'edit', index: 1 });
      expect(await store.pendingCommands()).toHaveLength(1);
      expect(gateway.updateFollowUp).not.toHaveBeenCalled();
    } finally {
      gate.resolve(record('recB'));
      await immediate();
      await store.getSnapshot(id, messageA);
    }
  });

  it('does not resurrect a completed command card when a late replay races with returning to the summary', async () => {
    const id = await prepare();
    await service.handle(submit(id));
    await service.runPendingTasks();
    gateway.patchInteractiveCard.mockClear();
    const originalClaim = store.claim.bind(store);
    jest.spyOn(store, 'claim').mockImplementationOnce(async input => {
      await service.handle(view(id, 'summary'));
      return originalClaim(input);
    });
    const replay = await service.handle(submit(id));
    expect(replay.card).toBeUndefined();
    await eventually(() => expect(gateway.patchInteractiveCard).toHaveBeenCalledWith(messageA, summary));
    expect(gateway.updateFollowUp).toHaveBeenCalledTimes(1);
    expect(await store.pendingCommands()).toEqual([]);
    expect((await store.getSnapshot(id, messageA)).message?.view).toEqual({ kind: 'summary' });
  });

  it.each([{ kind: 'summary' as const }, { kind: 'edit' as const, index: 1 }])('rejects a stale form after its card switches to %j', async currentView => {
    const id = await prepare();
    await store.setView(id, messageA, currentView);
    await expect(service.handle(submit(id))).rejects.toThrow();
    expect(await store.pendingCommands()).toEqual([]);
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
  });
});
