import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { LeaveWorkflowService, buildShiftAssignmentSummary } from '../../server/modules/leave-workflow/leave-workflow.service';
import { buildLeaveSubstituteAdjustmentCard } from '../../server/modules/leave-workflow/leave-workflow.card';
import { parseLeaveLongConnectionCardAction } from '../../server/modules/leave-workflow/leave-workflow.callback';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { currentHotfixActivation } from '../../server/common/hotfix-runtime-activation';
import { applicant, backup, fixture, primary, replacement, schedules } from './fixtures/leave-two-level';

describe('two-level leave service flow', () => {
  let directory: string;
  let store: LeaveWorkflowStore;
  let service: LeaveWorkflowService;
  let rows: typeof schedules;
  let gateway: { patchInteractiveCard: jest.Mock };
  let sync: any;
  let detail: any;
  let previousAppId: string | undefined;
  const data = () => fixture();
  const viewInput = () => ({ recordId: data().application.recordId, actorOpenId: 'ou_supervisor', messageId: 'om_test_two_level', stageKey: 'supervisor', stageVersion: 1, view: 'substitute_review', shiftSelections: [{ shiftKey: data().selection.shiftKey, substitutePersonRecordId: primary.personRecordId }] });
  beforeEach(async () => {
    previousAppId = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_two_level_synthetic';
    directory = await mkdtemp(join(tmpdir(), 'leave-two-level-service-owned-'));
    store = new LeaveWorkflowStore(join(directory, 'ledger.json'));
    await store.acceptApplication({ ...data().application, snapshot: { ...data().application.snapshot, applicantNotificationOpenIds: [] } });
    await store.patchApplication(data().application.recordId, { approvalPlan: data().plan });
    await store.setPendingStage(data().application.recordId, { key: 'supervisor', version: 1, approverOpenIds: ['ou_supervisor'] });
    await store.recordStageCardDelivery(data().application.recordId, { recipientOpenId: 'ou_supervisor', messageId: 'om_test_two_level', businessKey: `leave:${data().application.recordId}:stage:supervisor:1:ou_supervisor` });
    rows = structuredClone(schedules);
    const personnel = [applicant, primary, backup, replacement].map(person => ({ ...person, recordId: person.personRecordId, buildings: ['C'], employeeNo: null, systemPosition: '', supervisorNames: [] }));
    sync = { getCachedLeaveRequestImpactSchedules: jest.fn().mockImplementation(async () => rows), getCachedActivePersonnelDirectory: jest.fn().mockResolvedValue({ personnel, selectablePersonnel: personnel, managers: [], snapshot: { fetchedAt: Date.now(), expiresAt: Date.now() + 60_000, stale: false }, quality: {} }), syncApprovedLeaveScheduleSnapshot: jest.fn().mockResolvedValue({ nonDutyRecords: 1, scheduleRecords: 1 }) };
    gateway = { patchInteractiveCard: jest.fn().mockResolvedValue(undefined) };
    detail = { assertOriginalPostFieldReady: jest.fn().mockResolvedValue(undefined), ensurePendingRows: jest.fn().mockResolvedValue(undefined), upsertCurrentAssignments: jest.fn().mockResolvedValue(undefined) };
    service = new LeaveWorkflowService(store, gateway as never, sync, detail, { canUseFeishuBusinessIdentity: () => true } as never);
  });
  afterEach(async () => {
    if (previousAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousAppId;
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('leave-two-level-service-owned-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  it('reviews the delivered candidate snapshot without repeating directory or schedule reads or accepting an approval', async () => {
    sync.getCachedActivePersonnelDirectory.mockImplementation(() => new Promise(() => {}));
    const card = await service.renderApprovalCardView(viewInput() as any);
    expect(JSON.stringify(card)).toContain('原岗补位');
    expect(sync.getCachedActivePersonnelDirectory).not.toHaveBeenCalled();
    expect(sync.getCachedLeaveRequestImpactSchedules).not.toHaveBeenCalled();
    expect((await store.getApplication(data().application.recordId))?.status).toBe('supervisor_pending');
  });

  it.each([false, true])('keeps the real card callback responsive with cold ledger state and queued background I/O (large=%s)', async large => {
    const file = join(directory, 'ledger.json');
    if (large) {
      const ledger = JSON.parse(await readFile(file, 'utf8')), base = ledger.applications[0];
      const people = Array.from({ length: 160 }, (_, i) => ({ personRecordId: `rec_background_${i}`, name: `TEST_${i}`, openId: `ou_background_${i}`, position: '运维值班员', buildings: ['C楼'] }));
      ledger.applications.push(...Array.from({ length: 236 }, (_, i) => ({ ...base, key: `leave:rec_historical_${i}`, recordId: `rec_historical_${i}`, clientMutationId: `historical_${i}`, snapshot: { ...base.snapshot, substituteCandidates: people, candidateSets: [{ shiftKey: data().selection.shiftKey, candidates: people }] }, stageCards: [] })));
      await writeFile(file, JSON.stringify(ledger), 'utf8');
    }
    const ledgerBytes = Buffer.byteLength(await readFile(file, 'utf8'));
    if (large) expect(ledgerBytes).toBeGreaterThan(9_000_000);
    store = new LeaveWorkflowStore(file);
    service = new LeaveWorkflowService(store, gateway as never, sync, detail, { canUseFeishuBusinessIdentity: () => true } as never);
    const activation = currentHotfixActivation(); activation.completeBootstrap(); await activation.refresh();
    const unused = { isEnabled: () => false } as never;
    const router = new FeishuCardActionRouter(unused, service, unused, unused, unused, unused, unused, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
    const wake = jest.spyOn(service, 'runPendingTasks').mockResolvedValue({ processed: 0, failed: 0 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = (store as any).enqueue(() => gate, false);
    await new Promise<void>(resolve => setImmediate(resolve));
    const background = Array.from({ length: 6 }, () =>
      (store as any).enqueue(async () => {
        await readFile(file, 'utf8');
        await new Promise<void>(resolve => setTimeout(resolve, 500));
      }, false));
    const selection = data().selection;
    const payload = { event_type: 'card.action.trigger', event_id: 'evt_queued', operator: { open_id: 'ou_supervisor' }, context: { open_message_id: 'om_test_two_level' }, action: { tag: 'button', name: 'leave_approve_submit:rec_leave_two_level:supervisor:1:g1:r1', form_value: {
      [`leave_shift_substitute_${Buffer.from(selection.shiftKey).toString('base64url')}`]: primary.personRecordId,
      [`leave_shift_backfill_${Buffer.from(JSON.stringify([selection.shiftKey, primary.personRecordId, selection.originalPostSignature])).toString('base64url')}`]: backup.personRecordId,
    } } };
    const start = performance.now();
    const request = router.handle(payload);
    release();
    const response = await request, elapsedMs = performance.now() - start;
    await Promise.all([active, ...background]);
    const replay = await router.handle({ ...payload, event_id: 'evt_queued_retry' });
    const action = await store.getStageAction(data().application.recordId, 'supervisor', 1);
    expect(action).not.toBeNull();
    expect(replay.card?.type).toBe('raw');
    expect((JSON.parse(await readFile(file, 'utf8'))).actions).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(large ? 2500 : 1500);
    expect(response.toast.type).toBe('info');
    expect(response.card?.type).toBe('raw');
    expect(JSON.stringify(response.card)).not.toContain('form_action_type');
    expect(JSON.stringify(response.card)).toContain('"disabled":true');
    if (process.env.NT_LEAVE_RESPONSE_REPORT) await writeFile(process.env.NT_LEAVE_RESPONSE_REPORT + (large ? '.large.json' : ''), JSON.stringify({
      elapsedMs, ledgerBytes, coldStore: true, warning: response.toast.content.includes('处理时间较长'), rawCard: response.card?.type === 'raw',
      acceptedExactlyOnce: true, queuedBackgroundOperations: 6, simulatedIoPerOperationMs: 500,
      realNetworkCalls: 0,
    }, null, 2), { flag: 'wx' });
    wake.mockRestore();
  }, 15000);
  it('logs bounded approval timing only after the durable decision without exposing event or reason', async () => {
    const log = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    const result = await service.acceptApprovalAction({
      eventId: 'SYNTHETIC_PRIVATE_EVENT_DO_NOT_LOG', recordId: data().application.recordId,
      stageKey: 'supervisor', stageVersion: 1, actorOpenId: 'ou_supervisor',
      messageId: 'om_test_two_level', action: 'approve', shiftSelections: [data().selection],
    });
    expect(result.claimed).toBe(true);
    expect(await store.getStageAction(data().application.recordId, 'supervisor', 1)).not.toBeNull();
    const messages = log.mock.calls.map(call => String(call[0]));
    expect(messages).toEqual([expect.stringMatching(/^请休假受理耗时 record=rec_leave_two_level prepareMs=\d+ commitMs=\d+ totalMs=\d+ claimed=true$/)]);
    expect(messages.join(' ')).not.toMatch(/SYNTHETIC_PRIVATE_EVENT_DO_NOT_LOG|TEST 两级替班|ou_supervisor/);
    log.mockRestore();
  });
  it('accepts ten real-router decisions within the callback deadline with a same-scale ledger', async () => {
    const file = join(directory, 'ledger.json'), ledger = JSON.parse(await readFile(file, 'utf8'));
    const base = ledger.applications[0];
    const people = Array.from({ length: 160 }, (_, index) => ({ personRecordId: `rec_perf_person_${index}`, name: `TEST_${index}`, openId: `ou_perf_${index}`, position: '运维值班员', buildings: ['C楼'] }));
    ledger.applications = Array.from({ length: 237 }, (_, index) => ({ ...base, key: `leave:rec_perf_${index}`, recordId: `rec_perf_${index}`, clientMutationId: `perf_client_${index}`,
      snapshot: index < 10 ? base.snapshot : { ...base.snapshot, substituteCandidates: people, candidateSets: [{ shiftKey: data().selection.shiftKey, candidates: people }] },
      stageCards: [{ ...base.stageCards[0], messageId: `om_perf_${index}`, businessKey: `leave:rec_perf_${index}:stage:supervisor:1:ou_supervisor` }],
    }));
    ledger.tasks = Array.from({ length: 1543 }, (_, index) => ({ key: `perf_task_${index}`, businessKey: `perf_task_${index}`, recordId: 'rec_perf_0', kind: 'route_application', payload: {}, status: 'completed', attempts: 1, createdAt: base.createdAt, updatedAt: base.updatedAt, nextAttemptAt: base.createdAt, leaseUntil: '', claimToken: '', completedAt: base.updatedAt, lastError: '' }));
    const text = JSON.stringify(ledger), bytes = Buffer.byteLength(text);
    expect(bytes).toBeGreaterThan(9_000_000);
    await writeFile(file, text, 'utf8');
    await store.getApplication('rec_perf_0');
    const activation = currentHotfixActivation(); activation.completeBootstrap(); await activation.refresh();
    const unused = { isEnabled: () => false } as never;
    const router = new FeishuCardActionRouter(unused, service, unused, unused, unused, unused, unused, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
    const background = jest.spyOn(service, 'runPendingTasks').mockResolvedValue({ processed: 0, failed: 0 });
    const timingLog = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    const raw: number[] = [], selection = data().selection;
    for (let index = 0; index < 10; index++) {
      await writeFile(file, text, 'utf8');
      const payload = { event_type: 'card.action.trigger', event_id: `evt_perf_${index}`, operator: { open_id: 'ou_supervisor' }, context: { open_message_id: `om_perf_${index}` }, action: { tag: 'button', name: `leave_approve_submit:rec_perf_${index}:supervisor:1:g1:r1`, form_value: {
        [`leave_shift_substitute_${Buffer.from(selection.shiftKey).toString('base64url')}`]: primary.personRecordId,
        [`leave_shift_backfill_${Buffer.from(JSON.stringify([selection.shiftKey, primary.personRecordId, selection.originalPostSignature])).toString('base64url')}`]: backup.personRecordId,
      } } };
      const start = performance.now(), response = await router.handle(payload); raw.push(performance.now() - start);
      expect(response.toast.type).toBe('info'); expect(response.card?.type).toBe('raw');
      expect(JSON.stringify(response.card)).not.toContain('form_action_type');
      expect(await store.getStageAction(`rec_perf_${index}`, 'supervisor', 1)).not.toBeNull();
    }
    const sorted = [...raw].sort((a,b) => a-b), p95 = sorted[Math.ceil(raw.length * 0.95) - 1];
    expect(p95).toBeLessThan(2500);
    const output = process.env.NT_XJ_ROUTER_PERF_REPORT;
    if (output) await writeFile(output, JSON.stringify({ syntheticOnly: true, node: process.version, bytes, applications: 237, baseTasks: 1543, warmup: 'one full ledger read', samples: 10, stateResetBeforeEachSample: true, rawMs: raw, p95Ms: p95, deadlineMs: 2500, realNetworkCalls: 0, realMessagesSent: 0, backgroundOutboxIsolated: true, limitation: 'Ten independent valid approvals; fixture reset outside measured callback. Real Router/Service/Store on local synthetic cached directory/roster; not actual WS transport, cloud latency or mobile presentation.' }, null, 2), { flag: 'wx' });
    background.mockRestore(); timingLog.mockRestore();
  }, 60_000);
  it('falls back to fresh local candidates when an old snapshot lacks two-level choices', async () => {
    const current = (await store.getApplication(data().application.recordId))!;
    await store.patchApplication(current.recordId, { snapshot: { ...current.snapshot, candidateSets: current.snapshot.candidateSets!.map(({ twoLevelCandidates: _ignored, ...set }) => set) } });
    expect(JSON.stringify(await service.renderApprovalCardView(viewInput() as any))).toContain('原岗补位');
    expect(sync.getCachedLeaveRequestImpactSchedules).toHaveBeenCalledTimes(1);
  });
  it.each(['approve', 'reject'] as const)('repairs review navigation after an already claimed %s without creating another decision', async (action) => {
    const recordId = data().application.recordId;
    await store.claimStageAction({ ...viewInput(), stageKey: 'supervisor', eventId: `test-review-already-${action}`, action, shiftAssignments: data().assignments, rejectionReason: action === 'reject' ? 'TEST 原因' : undefined });
    const card = await service.renderApprovalCardView(viewInput() as any);
    expect(JSON.stringify(card)).toContain(action === 'reject' ? '已驳回' : '阶段已完成');
    expect(JSON.stringify(card)).not.toContain('form_action_type');
    await service.patchApprovalCardView(viewInput() as any, card);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_test_two_level', card);
    expect((await store.getStageAction(recordId, 'supervisor', 1))?.eventId).toBe(`test-review-already-${action}`);
    expect(sync.getCachedLeaveRequestImpactSchedules).not.toHaveBeenCalled();
  });
  it('turns a delivered superseded stage card into a transfer notice instead of denying the former approver', async () => {
    await store.setPendingStage(data().application.recordId, { key: 'supervisor', version: 2, approverOpenIds: ['ou_next_supervisor'] });
    const card = await service.renderApprovalCardView(viewInput() as any);
    expect(JSON.stringify(card)).toContain('已转交');
    expect(JSON.stringify(card)).not.toContain('form_action_type');
    await service.patchApprovalCardView(viewInput() as any, card);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_test_two_level', card);
  });
  it('never revives an editable review when the stage is claimed before the view patch', async () => {
    const card = await service.renderApprovalCardView(viewInput() as any);
    await store.claimStageAction({ ...viewInput(), stageKey: 'supervisor', eventId: 'test-review-race', action: 'reject', rejectionReason: 'TEST 已驳回' });
    await service.patchApprovalCardView(viewInput() as any, card);
    const patched = gateway.patchInteractiveCard.mock.calls[0][1];
    expect(JSON.stringify(patched)).toContain('已驳回');
    expect(JSON.stringify(patched)).not.toContain('form_action_type');
  });
  it('rejects forged historical stage versions even when the actor owns the message', async () => {
    await expect(service.renderApprovalCardView({ ...viewInput(), stageVersion: 99 } as any)).rejects.toThrow(/阶段|卡片|消息/);
  });
  it('does not let an old delivered message open a later live stage by changing its version', async () => {
    await store.setPendingStage(data().application.recordId, { key: 'supervisor', version: 2, approverOpenIds: ['ou_supervisor'] });
    await expect(service.renderApprovalCardView({ ...viewInput(), stageVersion: 2 } as any)).rejects.toThrow(/阶段|消息|卡片/);
  });
  it('attributes a later final rejection to its real approver rather than the old-stage approver', async () => {
    const recordId = data().application.recordId;
    await store.claimStageAction({ ...viewInput(), stageKey: 'supervisor', eventId: 'test-review-final-actor', action: 'approve', actorName: 'TEST 主管', shiftAssignments: data().assignments });
    await store.setPendingStage(recordId, { key: 'manager', version: 2, approverOpenIds: ['ou_manager'] });
    await store.recordStageCardDelivery(recordId, { recipientOpenId: 'ou_manager', messageId: 'om_final_manager', businessKey: `leave:${recordId}:stage:manager:2:ou_manager` });
    await store.claimStageAction({ ...viewInput(), stageKey: 'manager', stageVersion: 2, actorOpenId: 'ou_manager', messageId: 'om_final_manager', eventId: 'test-review-final-manager', action: 'reject', actorName: 'TEST 经理', rejectionReason: 'TEST 经理驳回原因' });
    await store.patchApplication(recordId, { status: 'rejected' });
    const card = JSON.stringify(await service.renderApprovalCardView(viewInput() as any));
    expect(card).toContain('TEST 经理');
    expect(card).toContain('TEST 经理驳回原因');
    expect(card).not.toContain('TEST 主管');
  });
  it('rejects another actor or message after the original stage has completed', async () => {
    await store.claimStageAction({ ...viewInput(), stageKey: 'supervisor', eventId: 'test-review-owner', action: 'reject', rejectionReason: 'TEST 原因' });
    await expect(service.renderApprovalCardView({ ...viewInput(), actorOpenId: 'ou_unrelated' } as any)).rejects.toThrow(/消息/);
    await expect(service.renderApprovalCardView({ ...viewInput(), messageId: 'om_unrelated' } as any)).rejects.toThrow(/消息/);
    await expect(service.renderApprovalCardView({ ...viewInput(), messageId: undefined } as any)).rejects.toThrow(/阶段|卡片/);
  });
  it('repairs a terminal decision made while the editing PATCH was in flight', async () => {
    const card = await service.renderApprovalCardView(viewInput() as any);
    gateway.patchInteractiveCard.mockImplementationOnce(async () => {
      await store.claimStageAction({ ...viewInput(), stageKey: 'supervisor', eventId: 'test-review-patch-race', action: 'reject', rejectionReason: 'TEST 并发驳回' });
    });
    await service.patchApprovalCardView(viewInput() as any, card);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    const terminal = JSON.stringify(gateway.patchInteractiveCard.mock.calls[1][1]);
    expect(terminal).toContain('已驳回');
    expect(terminal).not.toContain('form_action_type');
  });
  it('reviews a manager-stage card using its real stage version', async () => {
    const recordId = data().application.recordId;
    await store.setPendingStage(recordId, { key: 'manager', version: 2, approverOpenIds: ['ou_manager'] });
    await store.recordStageCardDelivery(recordId, { recipientOpenId: 'ou_manager', messageId: 'om_manager_review', businessKey: `leave:${recordId}:stage:manager:2:ou_manager` });
    const card = await service.renderApprovalCardView({ ...viewInput(), stageKey: 'manager', stageVersion: 2, actorOpenId: 'ou_manager', messageId: 'om_manager_review' } as any);
    expect(JSON.stringify(card)).toContain(`leave_approve_submit:${recordId}:manager:2`);
    expect((await store.getApplication(recordId))?.currentStage?.version).toBe(2);
    expect(await store.getStageAction(recordId, 'manager', 2)).toBeNull();
  });
  it('routes a real review and its later stale retry without a timeout or a new decision', async () => {
    const activation = currentHotfixActivation();
    activation.completeBootstrap(); await activation.refresh();
    const unused = { isEnabled: () => false } as never;
    const router = new FeishuCardActionRouter(unused, service, unused, unused, unused, unused, unused, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
    const payload = { event_type: 'card.action.trigger', operator: { open_id: 'ou_supervisor' }, context: { open_message_id: 'om_test_two_level' }, action: { tag: 'button', name: `leave_substitute_review_submit:${data().application.recordId}:supervisor:1:g1:r1`, form_value: { [`leave_shift_substitute_${Buffer.from(data().selection.shiftKey).toString('base64url')}`]: primary.personRecordId } } };
    sync.getCachedActivePersonnelDirectory.mockImplementation(() => new Promise(() => {}));
    for (const completed of [false, true]) {
      if (completed) await store.claimStageAction({ ...viewInput(), stageKey: 'supervisor', eventId: 'test-router-stale-review', action: 'reject', rejectionReason: 'TEST 已办理' });
      let patched!: () => void;
      const patchDone = new Promise<void>((resolve) => { patched = resolve; });
      gateway.patchInteractiveCard.mockImplementation(async () => { patched(); });
      const response = await router.handle(payload);
      expect(response.toast.type).toBe('info');
      expect(response).not.toHaveProperty('card');
      await patchDone;
      const content = JSON.stringify(gateway.patchInteractiveCard.mock.calls.at(-1)![1]);
      expect(content).toContain(completed ? '已驳回' : '原岗补位');
      if (completed) expect(content).not.toContain('form_action_type');
      // Wait for the view's final local state check before cleaning its ledger.
      await store.getApplication(data().application.recordId);
    }
    expect(sync.getCachedActivePersonnelDirectory).not.toHaveBeenCalled();
  });
  it('rejects navigation from a message not delivered to that approver', async () => {
    await expect(service.renderApprovalCardView({ ...viewInput(), messageId: 'om_unrelated' } as any)).rejects.toThrow(/卡片|消息/);
  });
  it('accepts the complete chain through the real service and forwards both posts to schedule synchronization', async () => {
    const result = await service.acceptApprovalAction({ ...viewInput(), eventId: 'test-service-two-level', stageKey: 'supervisor', action: 'approve', shiftSelections: [data().selection] });
    expect(result.claimed).toBe(true);
    expect(JSON.stringify(result.card)).not.toContain('form_action_type');
    await store.patchApplication(data().application.recordId, { status: 'approved' });
    await (service as any).syncApprovedLeaveSchedule({ recordId: data().application.recordId, payload: { revision: 0 } });
    expect(detail.upsertCurrentAssignments).toHaveBeenCalledWith(data().application.recordId, 0, expect.arrayContaining([expect.objectContaining({ originalPostBackfills: data().assignments[0].originalPostBackfills })]));
    expect(detail.upsertCurrentAssignments.mock.invocationCallOrder[0]).toBeLessThan(sync.syncApprovedLeaveScheduleSnapshot.mock.invocationCallOrder[0]);
    expect(sync.syncApprovedLeaveScheduleSnapshot.mock.calls[0][0][0].originalPostBackfills).toEqual(data().assignments[0].originalPostBackfills);
  });
  it('returns the durable result on approval retry without recalculating eligibility', async () => {
    const input = { ...viewInput(), eventId: 'test-approval-retry-fast', stageKey: 'supervisor' as const, action: 'approve' as const, shiftSelections: [data().selection] };
    expect((await service.acceptApprovalAction(input)).claimed).toBe(true);
    sync.getCachedActivePersonnelDirectory.mockClear().mockRejectedValue(new Error('Candidate refresh must not run on replay'));
    const replay = await service.acceptApprovalAction({ ...input, eventId: 'test-approval-retry-new-event' });
    expect(replay.claimed).toBe(false);
    expect(JSON.stringify(replay.card)).not.toContain('form_action_type');
    expect(sync.getCachedActivePersonnelDirectory).not.toHaveBeenCalled();
  });
  it('persists a priority card update with the decision and restores it after reopening the ledger', async () => {
    const initial = await store.takeNextTask();
    await store.completeTask(initial!.key, initial!.claimToken);
    const input = { ...viewInput(), eventId: 'test-priority-card-ack', stageKey: 'supervisor' as const, action: 'approve' as const, shiftSelections: [data().selection] };
    await service.acceptApprovalAction(input);
    await service.acceptApprovalAction({ ...input, eventId: 'test-priority-card-ack-replay' });
    const reopened = new LeaveWorkflowStore(join(directory, 'ledger.json'));
    const tasks = await reopened.listTasks();
    expect(tasks.filter(task => task.kind === 'sync_stage_action_cards')).toHaveLength(1);
    expect(await reopened.takeNextTask()).toMatchObject({ kind: 'sync_stage_action_cards', payload: { stageKey: 'supervisor', stageVersion: 1 } });
    expect(await reopened.getStageAction(input.recordId, 'supervisor', 1)).toMatchObject({ actorName: '主管' });
  });
  it('locks the original stage card before any slow cloud application or schedule task', async () => {
    const initial = await store.takeNextTask();
    await store.completeTask(initial!.key, initial!.claimToken);
    await store.enqueueTask({ businessKey: 'test-older-slow-schedule', recordId: data().application.recordId, kind: 'sync_approved_leave_schedule' });
    await service.acceptApprovalAction({ ...viewInput(), eventId: 'test-card-before-cloud', stageKey: 'supervisor', action: 'approve', shiftSelections: [data().selection] });
    const apply = jest.spyOn(service as any, 'applyStageAction').mockImplementation(() => new Promise(() => {}));
    await service.runPendingTasks(new Date(), 1);
    expect(apply).not.toHaveBeenCalled();
    expect(sync.syncApprovedLeaveScheduleSnapshot).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_test_two_level', expect.any(Object));
    const card = JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1]);
    expect(card).toContain('同步');
    expect(card).not.toContain('form_action_type');
    expect(card).not.toContain('behaviors');
  });
  it('shows the completed decision and snapshotted actor on a new-event approval replay', async () => {
    const input = { ...viewInput(), eventId: 'test-completed-card', stageKey: 'supervisor' as const, action: 'approve' as const, shiftSelections: [data().selection] };
    await service.acceptApprovalAction(input);
    await store.patchApplication(input.recordId, { status: 'approved' });
    const replay = await service.acceptApprovalAction({ ...input, eventId: 'test-completed-card-retry' });
    expect(replay.claimed).toBe(false);
    expect(replay.card).toMatchObject({ header: { title: { content: '请休假申请已通过' } } });
    const content = JSON.stringify(replay.card);
    expect(content).toContain('主管');
    expect(content).not.toContain('其他审批人');
    expect(content).not.toContain('处理人：审批人');
  });
  it('recovers legacy decided cards at startup without creating a new decision', async () => {
    const activation = currentHotfixActivation(); activation.completeBootstrap(); await activation.refresh();
    await service.acceptApprovalAction({ ...viewInput(), eventId: 'test-legacy-card-result', stageKey: 'supervisor', action: 'approve', shiftSelections: [data().selection] });
    await store.patchApplication(data().application.recordId, { status: 'approved', resolvedByName: '' });
    await store.markTerminalCardPatched(data().application.recordId, 'om_test_two_level');
    const path = join(directory, 'ledger.json');
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    ledger.tasks = [];
    ledger.actions[0].actorName = '';
    await writeFile(path, JSON.stringify(ledger));
    const reopened = new LeaveWorkflowStore(path, path);
    try {
      await reopened.onModuleInit();
      await reopened.acceptApplication({ ...data().application, recordId: 'rec_new_after_recovery', clientMutationId: 'test-new-after-recovery' });
      const newTask = await reopened.takeNextTask();
      expect(newTask).toMatchObject({ kind: 'route_application', recordId: 'rec_new_after_recovery' });
      await reopened.completeTask(newTask!.key, newTask!.claimToken);
      const task = await reopened.takeNextTask();
      expect(task).toMatchObject({ kind: 'sync_stage_action_cards', payload: { recovery: true } });
      await (service as any).processTask(task, new Date());
      const card = gateway.patchInteractiveCard.mock.calls[0][1];
      expect(card).toMatchObject({ header: { title: { content: '请休假申请已通过' } } });
      expect(JSON.stringify(card)).toContain('处理人：主管');
      expect(JSON.parse(await readFile(path, 'utf8')).actions).toHaveLength(1);
      await reopened.completeTask(task!.key, task!.claimToken);
      await reopened.onModuleInit();
      expect(await reopened.takeNextTask()).toBeNull();
    } finally { await reopened.onModuleDestroy(); }
  });
  it('retries failed card copies with the actual platform cause and skips successful copies', async () => {
    const initial = await store.takeNextTask(); await store.completeTask(initial!.key, initial!.claimToken);
    await store.recordStageCardDelivery(data().application.recordId, { recipientOpenId: 'ou_second', messageId: 'om_second', businessKey: `leave:${data().application.recordId}:stage:supervisor:1:ou_second` });
    await service.acceptApprovalAction({ ...viewInput(), eventId: 'test-partial-card-retry', stageKey: 'supervisor', action: 'approve', shiftSelections: [data().selection] });
    (gateway as any).updateLeaveRecord = jest.fn().mockResolvedValue(undefined);
    let failures = 1;
    gateway.patchInteractiveCard.mockImplementation(async (messageId: string) => { if (messageId === 'om_second' && failures-- > 0) throw new Error('HTTP 400 Feishu 230099 TEST rejected'); });
    expect(await service.runPendingTasks(new Date(), 1)).toEqual({ processed: 0, failed: 1 });
    const pending = (await store.listTasks()).find(task => task.kind === 'sync_stage_action_cards')!;
    expect(pending.lastError).toContain('230099');
    expect((gateway as any).updateLeaveRecord).not.toHaveBeenCalled();
    expect(await service.runPendingTasks(new Date(Date.parse(pending.nextAttemptAt) + 1), 1)).toEqual({ processed: 1, failed: 0 });
    expect(gateway.patchInteractiveCard.mock.calls.filter(call => call[0] === 'om_test_two_level')).toHaveLength(1);
    expect(gateway.patchInteractiveCard.mock.calls.filter(call => call[0] === 'om_second')).toHaveLength(2);
  });
  it('does not downgrade a final result if the pending-state PATCH completes after approval synchronization', async () => {
    const initial = await store.takeNextTask(); await store.completeTask(initial!.key, initial!.claimToken);
    await service.acceptApprovalAction({ ...viewInput(), eventId: 'test-result-card-race', stageKey: 'supervisor', action: 'approve', shiftSelections: [data().selection] });
    gateway.patchInteractiveCard.mockImplementationOnce(async () => { await store.patchApplication(data().application.recordId, { status: 'approved' }); });
    await service.runPendingTasks(new Date(), 1);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.patchInteractiveCard.mock.calls[1][1]).toMatchObject({ header: { title: { content: '请休假申请已通过' } } });
  });
  it('patches the original card after a callback deadline without a second click', async () => {
    const initial = await store.takeNextTask(); await store.completeTask(initial!.key, initial!.claimToken);
    const activation = currentHotfixActivation(); activation.completeBootstrap(); await activation.refresh();
    const directoryResult = await sync.getCachedActivePersonnelDirectory();
    let release!: (value: any) => void;
    let entered!: () => void;
    const reachedDirectory = new Promise<void>(resolve => { entered = resolve; });
    sync.getCachedActivePersonnelDirectory.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const run = service.runPendingTasks.bind(service);
    jest.spyOn(service, 'runPendingTasks').mockImplementation(async now => { try { return await run(now, 1); } finally { finish(); } });
    const unused = { isEnabled: () => false } as never;
    const router = new FeishuCardActionRouter(unused, service, unused, unused, unused, unused, unused, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
    const selection = data().selection;
    const payload = { event_type: 'card.action.trigger', operator: { open_id: 'ou_supervisor' }, context: { open_message_id: 'om_test_two_level' }, action: { tag: 'button', name: `leave_approve_submit:${data().application.recordId}:supervisor:1:g1:r1`, form_value: {
      [`leave_shift_substitute_${Buffer.from(selection.shiftKey).toString('base64url')}`]: primary.personRecordId,
      [`leave_shift_backfill_${Buffer.from(JSON.stringify([selection.shiftKey, primary.personRecordId, selection.originalPostSignature])).toString('base64url')}`]: backup.personRecordId,
    } } };
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const response = router.handle(payload);
      await reachedDirectory;
      await jest.advanceTimersByTimeAsync(2501);
      expect(await response).toMatchObject({ toast: { type: 'warning' } });
      expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
      release(directoryResult);
      await finished;
      expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_test_two_level', expect.any(Object));
      expect(JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1])).not.toContain('form_action_type');
      expect(await store.getStageAction(data().application.recordId, 'supervisor', 1)).not.toBeNull();
    } finally { jest.useRealTimers(); }
  });
  it('approves a selected free substitute without requiring an original-post backup', async () => {
    const result = await service.acceptApprovalAction({ ...viewInput(), eventId: 'test-free-primary-approval', stageKey: 'supervisor', action: 'approve', shiftSelections: [{ shiftKey: data().selection.shiftKey, substitutePersonRecordId: replacement.personRecordId }] });
    expect(result.claimed).toBe(true);
    const action = await store.getStageAction(data().application.recordId, 'supervisor', 1);
    expect(action?.shiftAssignments[0].substitutePersonRecordId).toBe(replacement.personRecordId);
    expect(action?.shiftAssignments[0].originalPostBackfills).toBeUndefined();
  });
  it('rejects a primary or original post changed after review before claiming a decision', async () => {
    rows[1].recordId = 'rec_changed_after_review';
    await expect(service.acceptApprovalAction({ ...viewInput(), eventId: 'test-stale-two-level', stageKey: 'supervisor', action: 'approve', shiftSelections: [data().selection] })).rejects.toThrow(/原岗|变化|不可用/);
    expect((await store.getApplication(data().application.recordId))?.currentStage).not.toBeNull();
  });
  it('accepts a complete durable two-level decision without requiring a new cloud column', async () => {
    detail.assertOriginalPostFieldReady.mockRejectedValue(new Error('No new cloud column'));
    const result = await service.acceptApprovalAction({ ...viewInput(), eventId: 'test-local-only-no-column', stageKey: 'supervisor', action: 'approve', shiftSelections: [data().selection] });
    expect(result.claimed).toBe(true);
    expect(detail.assertOriginalPostFieldReady).not.toHaveBeenCalled();
    expect((await store.getApplication(data().application.recordId))?.snapshot.shiftAssignments?.[0].originalPostBackfills).toEqual(data().assignments[0].originalPostBackfills);
  });
  it('does not drop backup selection when carrying forward the previous approval stage arrangement', async () => {
    const application = (await store.getApplication(data().application.recordId))!;
    application.snapshot.shiftAssignments = data().assignments;
    const assignments = (service as any).resolveSubmittedShiftAssignments(application, [], data().candidateSets, 'ou_supervisor', '主管', false);
    expect(assignments[0].originalPostBackfills).toEqual(data().assignments[0].originalPostBackfills);
  });
  it('shows both assignments in the business summary', () => {
    const summary = buildShiftAssignmentSummary(data().assignments);
    expect(summary).toContain(primary.name); expect(summary).toContain('原岗补位'); expect(summary).toContain(backup.name); expect(summary).toContain('C楼');
  });
  it('reviews an adjustment before changing the original-post backup and keeps final submission a business action', () => {
    const card = buildLeaveSubstituteAdjustmentCard({ ...data().cardContext, shiftAssignments: data().assignments, assignmentRevision: 0 }, 0);
    expect(JSON.stringify(card)).toContain('leave_substitute_review_update_submit:');
    const payload = { event_type: 'card.action.trigger', operator: { open_id: 'ou_supervisor' }, context: { open_message_id: 'om_test_two_level' }, action: { tag: 'button', name: `leave_substitute_review_update_submit:${data().application.recordId}:0:g1:r0`, form_value: { [`leave_shift_substitute_${Buffer.from(data().selection.shiftKey).toString('base64url')}`]: primary.personRecordId } } };
    expect(parseLeaveLongConnectionCardAction(payload)).toMatchObject({ kind: 'adjustment_view', expectedRevision: 0, shiftSelections: [{ shiftKey: data().selection.shiftKey, substitutePersonRecordId: primary.personRecordId }] });
  });
  it.each(['selection', 'review'] as const)('preserves a nonzero adjustment revision in the real service %s view', async (view) => {
    const recordId = data().application.recordId;
    const current = (await store.getApplication(recordId))!;
    await store.patchApplication(recordId, { status: 'approved', snapshot: { ...current.snapshot, assignmentRevision: 3, shiftAssignments: data().assignments } });
    await store.recordSubstituteAdjustmentCardDelivery(recordId, { recipientOpenId: 'ou_supervisor', messageId: 'om_test_adjustment_revision', businessKey: `leave:${recordId}:substitute-adjustment:3:ou_supervisor` });
    const card = await service.renderSubstituteAdjustmentCardView({ recordId, actorOpenId: 'ou_supervisor', messageId: 'om_test_adjustment_revision', expectedRevision: 3, view, shiftSelections: [data().selection] });
    const prefix = view === 'review' ? 'leave_substitute_update_submit' : 'leave_substitute_review_update_submit';
    const required = view === 'review' ? 1 : 0;
    expect(JSON.stringify(card)).toContain(`${prefix}:${recordId}:3:g1:r${required}`);
    expect(JSON.stringify(card)).not.toContain(`${prefix}:${recordId}:0:g1:r${required}`);
  });
});
