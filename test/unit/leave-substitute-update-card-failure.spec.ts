import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { validateLeaveShiftAssignmentPlan } from '../../server/modules/leave-workflow/leave-workflow.rules';
import { applicant, backup, fixture, primary, replacement } from './fixtures/leave-two-level';

describe('substitute update synchronization survives an old card failure', () => {
  let directory: string;
  let ledgerPath: string;
  let store: LeaveWorkflowStore;
  let service: LeaveWorkflowService;
  let gateway: { updateLeaveRecord: jest.Mock; readLeaveRecord: jest.Mock; patchInteractiveCard: jest.Mock; sendInteractiveCard: jest.Mock };
  let detailGateway: { ensurePendingRows: jest.Mock; upsertCurrentAssignments: jest.Mock };
  let scheduleSync: jest.Mock;
  let mainFields: Record<string, unknown>;
  let previousEnabled: string | undefined;
  let previousAppId: string | undefined;
  const data = fixture();
  const recordId = data.application.recordId;
  const kinds = ['sync_leave_shift_details', 'sync_approved_leave_schedule'];
  const syncTasks = async (source = store) => (await source.listTasks()).filter(task => kinds.includes(task.kind));
  const makeService = (target: LeaveWorkflowStore) => {
    const personnel = [applicant, primary, backup, replacement].map(person => ({
      ...person, recordId: person.personRecordId, employeeNo: null, systemPosition: '', supervisorNames: [],
    }));
    return new LeaveWorkflowService(target, gateway as never,
      { syncApprovedLeaveScheduleSnapshot: scheduleSync, getCachedActivePersonnelDirectory: jest.fn().mockResolvedValue({
        personnel, selectablePersonnel: personnel, managers: [], quality: {},
        snapshot: { fetchedAt: Date.now(), expiresAt: Date.now() + 60_000, stale: false },
      }) } as never, detailGateway as never, { canUseFeishuBusinessIdentity: () => true } as never);
  };
  const approvalState = async () => {
    const entry = (await store.getApplication(recordId))!;
    return {
      status: entry.status, resolvedAction: entry.resolvedAction,
      resolvedByOpenId: entry.resolvedByOpenId, resolvedAt: entry.resolvedAt,
      assignmentRevision: entry.snapshot.assignmentRevision,
      shiftAssignments: entry.snapshot.shiftAssignments,
    };
  };
  const prepareRevisionOneRetryWithDeliveredCard = async () => {
    gateway.patchInteractiveCard.mockResolvedValue(undefined);
    let failFinalClear = true;
    gateway.updateLeaveRecord.mockImplementation(async (_recordId: string, fields: Record<string, unknown>) => {
      if (failFinalClear && Object.keys(fields).length === 1 && fields['请假工作流错误'] === '') {
        failFinalClear = false;
        throw new Error('synthetic final error-clear failure after r1 card and durable follow-ups');
      }
      mainFields = { ...mainFields, ...fields };
    });
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 0, failed: 1 });
    expect(failFinalClear).toBe(false);
    expect(mainFields['替班调整版本']).toBe(1);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_old_substitute_card', expect.any(Object));
    await expect(service.runPendingTasks(new Date(), 4)).resolves.toEqual({ processed: 4, failed: 0 });
    const revisionOne = (await store.getApplication(recordId))!;
    const delivered = revisionOne.substituteAdjustmentCards.find(card => card.businessKey.includes(':substitute-adjustment:1:'));
    expect(delivered).toBeDefined();
    return delivered!.messageId;
  };
  const claimRevisionTwo = async (messageId: string) => {
    const next = validateLeaveShiftAssignmentPlan({
      groups: data.application.snapshot.shiftGroups, candidateSets: data.candidateSets,
      selections: [{ shiftKey: data.selection.shiftKey, substitutePersonRecordId: replacement.personRecordId }],
      actorOpenId: 'ou_supervisor', actorName: '调整人二', changedAt: new Date().toISOString(),
    });
    if (next.valid === false) throw new Error(next.message);
    const newer = await store.claimSubstituteUpdate({
      eventId: 'evt_synthetic_revision_two', recordId, expectedRevision: 1,
      actorOpenId: 'ou_supervisor', actorName: '调整人二', messageId, shiftAssignments: next.assignments,
    });
    expect(newer.accepted).toBe(true);
  };
  const prepareDeliveredCardWithPendingRefreshes = async () => {
    gateway.patchInteractiveCard.mockResolvedValue(undefined);
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 1, failed: 0 });
    const detailTask = await store.takeNextTask();
    const scheduleTask = await store.takeNextTask();
    expect(detailTask).toMatchObject({ kind: 'sync_leave_shift_details', payload: { revision: 1 } });
    expect(scheduleTask).toMatchObject({ kind: 'sync_approved_leave_schedule', payload: { revision: 1 } });
    // Real leases hold the refreshes while the actual adjustment-card delivery runs.
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 1, failed: 0 });
    const notification = await store.takeNextTask();
    expect(notification).toMatchObject({ kind: 'deliver_substitute_update_notifications', payload: { revision: 1 } });
    // Keep the unrelated notification leased; this test does not replay notification workflows.
    const application = (await store.getApplication(recordId))!;
    const card = application.substituteAdjustmentCards.find(item => item.businessKey.includes(':substitute-adjustment:1:'));
    expect(card).toBeDefined();
    for (const task of [detailTask!, scheduleTask!]) {
      await store.rescheduleTask(task.key, task.claimToken, new Error('synthetic refresh retry before external work'), new Date());
    }
    return { messageId: card!.messageId, detailKey: detailTask!.key, scheduleKey: scheduleTask!.key };
  };

  beforeEach(async () => {
    previousEnabled = process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED;
    previousAppId = process.env.FEISHU_APP_ID;
    process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED = 'true';
    process.env.FEISHU_APP_ID = 'cli_leave_card_failure_synthetic';
    directory = await mkdtemp(join(tmpdir(), 'leave-card-failure-owned-'));
    ledgerPath = join(directory, 'ledger.json');
    store = new LeaveWorkflowStore(ledgerPath, ledgerPath);
    await store.acceptApplication(data.application);
    await store.patchApplication(recordId, {
      status: 'approved', currentStage: null, approvalPlan: data.plan,
      resolvedAction: 'approve', resolvedByOpenId: 'ou_supervisor',
      resolvedByName: '原审批人', resolvedAt: '2026-10-16T01:00:00.000Z',
    });
    await store.recordSubstituteAdjustmentCardDelivery(recordId, {
      messageId: 'om_old_substitute_card', recipientOpenId: 'ou_supervisor',
      businessKey: `leave:${recordId}:substitute-adjustment:0:ou_supervisor`,
    });
    for (let task = await store.takeNextTask(); task; task = await store.takeNextTask()) {
      await store.completeTask(task.key, task.claimToken);
    }
    const claim = await store.claimSubstituteUpdate({
      eventId: 'evt_synthetic_substitute_update', recordId, expectedRevision: 0,
      actorOpenId: 'ou_supervisor', actorName: '调整人', messageId: 'om_old_substitute_card',
      shiftAssignments: data.assignments,
    });
    expect(claim.accepted).toBe(true);
    mainFields = {};
    let messageSequence = 0;
    gateway = {
      updateLeaveRecord: jest.fn(async (_recordId: string, fields: Record<string, unknown>) => {
        mainFields = { ...mainFields, ...fields };
      }),
      readLeaveRecord: jest.fn(async () => ({ record_id: recordId, fields: { ...mainFields } })),
      patchInteractiveCard: jest.fn().mockRejectedValue(new Error('synthetic card PATCH failure')),
      sendInteractiveCard: jest.fn(async () => `om_synthetic_delivery_${++messageSequence}`),
    };
    scheduleSync = jest.fn().mockResolvedValue({ nonDutyRecords: 1, scheduleRecords: 1 });
    detailGateway = { ensurePendingRows: jest.fn().mockResolvedValue(undefined), upsertCurrentAssignments: jest.fn().mockResolvedValue(undefined) };
    service = makeService(store);
  });

  afterEach(async () => {
    if (previousEnabled === undefined) delete process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED;
    else process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED = previousEnabled;
    if (previousAppId === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = previousAppId;
    jest.restoreAllMocks();
    if (!directory || !resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('leave-card-failure-owned-')) {
      throw new Error('Unsafe temporary test directory cleanup');
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('durably queues both platform refreshes before attempting a failing old card PATCH', async () => {
    let durableAtPatch: string[] = [];
    gateway.patchInteractiveCard.mockImplementation(async () => {
      durableAtPatch = (await syncTasks(new LeaveWorkflowStore(ledgerPath, ledgerPath))).map(task => task.kind);
      throw new Error('synthetic card PATCH failure');
    });
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 0, failed: 1 });
    expect(durableAtPatch.sort()).toEqual([...kinds].sort());
    const persisted = await syncTasks(new LeaveWorkflowStore(ledgerPath, ledgerPath));
    expect(persisted).toHaveLength(2);
    expect(persisted.map(task => task.businessKey).sort()).toEqual([
      `leave:${recordId}:schedule-sync:1`, `leave:${recordId}:shift-details:active:1`,
    ].sort());
    expect(persisted.every(task => task.status === 'pending' && task.payload.revision === 1)).toBe(true);
    expect((await store.listTasks()).find(task => task.kind === 'apply_substitute_update')).toMatchObject({
      status: 'pending', attempts: 1, lastError: expect.stringContaining('卡片终态更新未完成'),
    });
  });

  it('does not queue either refresh or patch cards when Bitable readback fails', async () => {
    gateway.readLeaveRecord.mockImplementation(async () => ({
      record_id: recordId, fields: { ...mainFields, 替班调整版本: 99 },
    }));
    const before = await approvalState();
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 0, failed: 1 });
    expect(gateway.updateLeaveRecord).toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
    expect(await syncTasks(new LeaveWorkflowStore(ledgerPath, ledgerPath))).toEqual([]);
    expect(await approvalState()).toEqual(before);
  });

  it('refreshes despite card failure, then retries without duplicating refresh tasks or changing approval', async () => {
    const approved = await approvalState();
    const update = await store.getSubstituteUpdate(recordId, 1);
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 0, failed: 1 });
    const firstTasks = await syncTasks();
    expect(firstTasks).toHaveLength(2);
    const retryAt = new Date(Date.now() + 10_000);
    await expect(service.runPendingTasks(retryAt, 2)).resolves.toEqual({ processed: 2, failed: 0 });
    expect(scheduleSync).toHaveBeenCalledTimes(1);
    expect((await syncTasks()).every(task => task.status === 'completed')).toBe(true);
    gateway.patchInteractiveCard.mockResolvedValue(undefined);
    await expect(service.runPendingTasks(retryAt, 1)).resolves.toEqual({ processed: 1, failed: 0 });
    const finalTasks = await syncTasks(new LeaveWorkflowStore(ledgerPath, ledgerPath));
    expect(finalTasks.map(task => task.key).sort()).toEqual(firstTasks.map(task => task.key).sort());
    expect(finalTasks.every(task => task.status === 'completed')).toBe(true);
    expect(await approvalState()).toEqual(approved);
    expect(await store.getSubstituteUpdate(recordId, 1)).toEqual(update);
    expect(await store.getSubstituteUpdate(recordId, 2)).toBeNull();
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.updateLeaveRecord.mock.calls.every(([, fields]) => !('请假工作流状态' in fields))).toBe(true);
  });

  it('reopens after the second enqueue persistence fails and repairs only the missing refresh intent', async () => {
    const approved = await approvalState();
    const persistence = store as unknown as { write(ledger: { tasks: { kind: string; payload: Record<string, unknown> }[] }): Promise<void> };
    const write = persistence.write.bind(store);
    let failedSecondWrite = false;
    const fault = jest.spyOn(persistence, 'write').mockImplementation(async ledger => {
      if (!failedSecondWrite && ledger.tasks.some(task => task.kind === 'sync_approved_leave_schedule' && task.payload.revision === 1)) {
        failedSecondWrite = true;
        throw new Error('synthetic second enqueue persistence failure');
      }
      await write(ledger);
    });
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 0, failed: 1 });
    expect(failedSecondWrite).toBe(true);
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
    fault.mockRestore();
    store = new LeaveWorkflowStore(ledgerPath, ledgerPath);
    const persistedFirst = await syncTasks();
    expect(persistedFirst).toHaveLength(1);
    expect(persistedFirst[0]).toMatchObject({ kind: 'sync_leave_shift_details', status: 'pending', payload: { revision: 1 } });
    service = makeService(store);
    gateway.patchInteractiveCard.mockResolvedValue(undefined);
    const retryAt = new Date(Date.now() + 10_000);
    // Later loop iterations use the real clock, so the backoff may still exclude the adjustment.
    await expect(service.runPendingTasks(retryAt, 2)).resolves.toMatchObject({ failed: 0 });
    const adjustment = (await store.listTasks()).find(task => task.kind === 'apply_substitute_update' && task.payload.revision === 1)!;
    if (adjustment.status !== 'completed') {
      await expect(service.runPendingTasks(retryAt, 1)).resolves.toMatchObject({ failed: 0 });
    }
    expect((await store.listTasks()).find(task => task.key === adjustment.key)?.status).toBe('completed');
    const repaired = await syncTasks(new LeaveWorkflowStore(ledgerPath, ledgerPath));
    expect(repaired).toHaveLength(2);
    expect(repaired.find(task => task.kind === 'sync_leave_shift_details')).toMatchObject({ key: persistedFirst[0].key, status: 'completed' });
    expect(repaired.find(task => task.kind === 'sync_approved_leave_schedule')).toMatchObject({ status: 'pending', payload: { revision: 1 } });
    expect(scheduleSync).not.toHaveBeenCalled();
    await expect(service.runPendingTasks(retryAt, 1)).resolves.toMatchObject({ failed: 0 });
    const completed = await syncTasks(new LeaveWorkflowStore(ledgerPath, ledgerPath));
    expect(completed.map(task => task.key).sort()).toEqual(repaired.map(task => task.key).sort());
    expect(completed.every(task => task.status === 'completed')).toBe(true);
    expect(scheduleSync).toHaveBeenCalledTimes(1);
    expect(await approvalState()).toEqual(approved);
    expect(await store.getSubstituteUpdate(recordId, 2)).toBeNull();
  });

  it('keeps completed refreshes completed through repeated old-card failures without repeating platform writes', async () => {
    const approved = await approvalState();
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 0, failed: 1 });
    await expect(service.runPendingTasks(new Date(Date.now() + 10_000), 2)).resolves.toEqual({ processed: 2, failed: 0 });
    const completed = await syncTasks();
    expect(completed).toHaveLength(2);
    expect(completed.every(task => task.status === 'completed')).toBe(true);
    const detailWrites = detailGateway.upsertCurrentAssignments.mock.calls.length;
    const scheduleWrites = scheduleSync.mock.calls.length;
    for (const minute of [1, 2, 3]) {
      await expect(service.runPendingTasks(new Date(Date.now() + minute * 60_000), 1)).resolves.toEqual({ processed: 0, failed: 1 });
      expect(await syncTasks(new LeaveWorkflowStore(ledgerPath, ledgerPath))).toEqual(completed);
      expect(await approvalState()).toEqual(approved);
      expect(mainFields['替班调整版本']).toBe(1);
    }
    expect(detailGateway.upsertCurrentAssignments).toHaveBeenCalledTimes(detailWrites);
    expect(scheduleSync).toHaveBeenCalledTimes(scheduleWrites);
    expect(await store.getSubstituteUpdate(recordId, 2)).toBeNull();
  });

  it('does not roll back a completed revision two when revision one retries after its final error-clear write failed', async () => {
    const deliveredMessageId = await prepareRevisionOneRetryWithDeliveredCard();
    await claimRevisionTwo(deliveredMessageId);
    await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({ processed: 1, failed: 0 });
    await expect(service.runPendingTasks(new Date(), 4)).resolves.toEqual({ processed: 4, failed: 0 });
    expect(mainFields['替班调整版本']).toBe(2);
    expect(mainFields['替班人员（填姓名）']).toBe(replacement.name);
    const newestFields = Object.fromEntries(Object.entries(mainFields).filter(([field]) => field !== '请假工作流错误'));
    const newestApproval = await approvalState();
    const boundTasks = await syncTasks();
    expect(boundTasks.map(task => task.businessKey).sort()).toEqual([
      `leave:${recordId}:shift-details:active:1`, `leave:${recordId}:schedule-sync:1`,
      `leave:${recordId}:shift-details:active:2`, `leave:${recordId}:schedule-sync:2`,
    ].sort());
    expect(boundTasks.every(task => task.status === 'completed')).toBe(true);
    gateway.updateLeaveRecord.mockClear();
    await service.runPendingTasks(new Date(Date.now() + 60_000), 1);
    // A stale task may settle or be rejected, but must never PUT an older decision.
    expect(gateway.updateLeaveRecord.mock.calls.some(([, fields]) => fields['替班调整版本'] === 1)).toBe(false);
    expect(mainFields).toEqual(expect.objectContaining(newestFields));
    expect(await approvalState()).toEqual(newestApproval);
    expect(await syncTasks(new LeaveWorkflowStore(ledgerPath, ledgerPath))).toEqual(boundTasks);
  });

  it('serializes two real workers so revision two cannot overtake an in-flight revision one PUT', async () => {
    const deliveredMessageId = await prepareRevisionOneRetryWithDeliveredCard();
    let releaseOld!: () => void;
    let oldStarted!: () => void;
    let newerClaimed!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const enteredOld = new Promise<void>(resolve => { oldStarted = resolve; });
    const claimedNewer = new Promise<void>(resolve => { newerClaimed = resolve; });
    const order: string[] = [];
    let revisionTwoIntentsAtPut: string[] | undefined;
    const write = gateway.updateLeaveRecord.getMockImplementation()!;
    let holdOld = true;
    gateway.updateLeaveRecord.mockImplementation(async (id: string, fields: Record<string, unknown>) => {
      if (fields['替班调整版本'] === 1 && holdOld) {
        holdOld = false;
        order.push('r1-start'); oldStarted(); await oldGate;
        await write(id, fields); order.push('r1-finish'); return;
      }
      if (fields['替班调整版本'] === 2) {
        order.push('r2-start');
        revisionTwoIntentsAtPut = (await syncTasks()).filter(task => task.payload.revision === 2).map(task => task.businessKey);
        await write(id, fields); order.push('r2-finish'); return;
      }
      await write(id, fields);
    });
    const take = store.takeNextTask.bind(store);
    jest.spyOn(store, 'takeNextTask').mockImplementation(async (now, leaseMs) => {
      const task = await take(now, leaseMs);
      if (task?.kind === 'apply_substitute_update' && task.payload.revision === 2) newerClaimed();
      return task;
    });
    const running: Promise<unknown>[] = [];
    try {
      const oldRun = service.runPendingTasks(new Date(Date.now() + 10_000), 1); running.push(oldRun);
      await enteredOld;
      await claimRevisionTwo(deliveredMessageId);
      const newerRun = service.runPendingTasks(new Date(), 1); running.push(newerRun);
      await claimedNewer;
      await new Promise<void>(resolve => setImmediate(resolve));
      // Drain actual store queue turns for the two pre-PUT reads, without a timing sleep.
      for (let turn = 0; turn < 3; turn++) await store.listTasks();
      const newerOvertook = order.includes('r2-start');
      releaseOld();
      const results = await Promise.all([oldRun, newerRun]);
      expect({ newerOvertook, order, revisionTwoIntentsAtPut, revision: mainFields['替班调整版本'], substitute: mainFields['替班人员（填姓名）'] }).toEqual({
        newerOvertook: false, order: ['r1-start', 'r1-finish', 'r2-start', 'r2-finish'],
        revisionTwoIntentsAtPut: [], revision: 2, substitute: replacement.name,
      });
      expect(results.every(result => result.failed === 0)).toBe(true);
      expect((await store.getApplication(recordId))!.snapshot.assignmentRevision).toBe(2);
    } finally {
      releaseOld();
      await Promise.allSettled(running);
    }
  });

  it('does not let an old detail payload consume a newer local snapshot before its main-table write', async () => {
    const delivered = await prepareDeliveredCardWithPendingRefreshes();
    await claimRevisionTwo(delivered.messageId);
    expect((await store.getApplication(recordId))!.snapshot.assignmentRevision).toBe(2);
    expect(mainFields['替班调整版本']).toBe(1);
    // Reserve the legitimate r2 apply task without executing its main-table write.
    const heldNewer = await store.takeNextTask();
    expect(heldNewer).toMatchObject({ kind: 'apply_substitute_update', payload: { revision: 2 } });
    detailGateway.ensurePendingRows.mockClear();
    detailGateway.upsertCurrentAssignments.mockClear();
    gateway.updateLeaveRecord.mockClear();
    await expect(service.runPendingTasks(new Date(Date.now() + 10_000), 1)).resolves.toEqual({ processed: 1, failed: 0 });
    expect((await store.listTasks()).find(task => task.key === delivered.detailKey)).toMatchObject({
      status: 'completed', payload: { revision: 1 },
    });
    expect(detailGateway.ensurePendingRows).not.toHaveBeenCalled();
    expect(detailGateway.upsertCurrentAssignments).not.toHaveBeenCalled();
    expect(gateway.updateLeaveRecord).not.toHaveBeenCalled();
    expect(mainFields['替班调整版本']).toBe(1);
    expect((await store.getApplication(recordId))!.snapshot.assignmentRevision).toBe(2);
  });

  it.each(['detail', 'schedule'] as const)('waits for an in-flight old %s consumer before writing the newer main record', async kind => {
    const delivered = await prepareDeliveredCardWithPendingRefreshes();
    const retryAt = new Date(Date.now() + 10_000);
    if (kind === 'schedule') {
      await expect(service.runPendingTasks(retryAt, 1)).resolves.toEqual({ processed: 1, failed: 0 });
      expect((await store.listTasks()).find(task => task.key === delivered.detailKey)?.status).toBe('completed');
    }
    let releaseOld!: () => void;
    let oldStarted!: () => void;
    let newerClaimed!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const enteredOld = new Promise<void>(resolve => { oldStarted = resolve; });
    const claimedNewer = new Promise<void>(resolve => { newerClaimed = resolve; });
    const order: string[] = [];
    let holdOld = true;
    let lastDetailRevision: number | undefined;
    let lastDetailSubstitute: string | undefined;
    let lastScheduleSubstitute: string | undefined;
    const holdConsumer = async () => {
      holdOld = false; order.push('old-consumer-start'); oldStarted();
      await oldGate; order.push('old-consumer-finish');
    };
    detailGateway.upsertCurrentAssignments.mockImplementation(async (_id: string, revision: number, assignments: { substituteName: string }[]) => {
      if (kind === 'detail' && revision === 1 && holdOld) await holdConsumer();
      lastDetailRevision = revision; lastDetailSubstitute = assignments[0]?.substituteName;
    });
    scheduleSync.mockImplementation(async (assignments: { substituteName: string }[]) => {
      if (kind === 'schedule' && assignments[0]?.substituteName === primary.name && holdOld) await holdConsumer();
      lastScheduleSubstitute = assignments[0]?.substituteName;
      return { nonDutyRecords: 1, scheduleRecords: 1 };
    });
    const write = gateway.updateLeaveRecord.getMockImplementation()!;
    gateway.updateLeaveRecord.mockImplementation(async (id: string, fields: Record<string, unknown>) => {
      if (fields['替班调整版本'] === 2) order.push('r2-main-start');
      await write(id, fields);
    });
    const take = store.takeNextTask.bind(store);
    jest.spyOn(store, 'takeNextTask').mockImplementation(async (now, leaseMs) => {
      const task = await take(now, leaseMs);
      if (task?.kind === 'apply_substitute_update' && task.payload.revision === 2) newerClaimed();
      return task;
    });
    const running: Promise<unknown>[] = [];
    try {
      const oldRun = service.runPendingTasks(retryAt, 1); running.push(oldRun);
      await enteredOld;
      await claimRevisionTwo(delivered.messageId);
      const newerRun = service.runPendingTasks(new Date(), 1); running.push(newerRun);
      await claimedNewer;
      await new Promise<void>(resolve => setImmediate(resolve));
      for (let turn = 0; turn < 3; turn++) await store.listTasks();
      const newerOvertook = order.includes('r2-main-start');
      releaseOld();
      const results = await Promise.all([oldRun, newerRun]);
      expect({ newerOvertook, order }).toEqual({
        newerOvertook: false, order: ['old-consumer-start', 'old-consumer-finish', 'r2-main-start'],
      });
      expect(results.every(result => result.failed === 0)).toBe(true);
      expect(mainFields['替班调整版本']).toBe(2);
      expect(mainFields['替班人员（填姓名）']).toBe(replacement.name);
      await expect(service.runPendingTasks(new Date(), 2)).resolves.toEqual({ processed: 2, failed: 0 });
      expect(lastDetailRevision).toBe(2);
      expect(lastDetailSubstitute).toBe(replacement.name);
      expect(lastScheduleSubstitute).toBe(replacement.name);
      const latestTasks = (await syncTasks()).filter(task => task.payload.revision === 2);
      expect(latestTasks).toHaveLength(2);
      expect(latestTasks.every(task => task.status === 'completed')).toBe(true);
    } finally {
      releaseOld();
      await Promise.allSettled(running);
    }
  });
});
