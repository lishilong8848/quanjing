import { ConflictException, ForbiddenException } from '@nestjs/common';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OvertimeWorkflowStore,
  stableOvertimeMessageUuid,
} from './overtime-workflow.store';

const SNAPSHOT = {
  recordId: 'rec_overtime_1',
  applicantName: '示例人员008',
  applicantOpenId: 'ou_applicant',
  building: 'A楼',
  position: '运维值班员',
  plannedStartAt: '2026-08-13T09:00:00+08:00',
  plannedEndAt: '2026-08-13T17:00:00+08:00',
  plannedHours: 8,
  reason: '设备保障',
};

describe('OvertimeWorkflowStore', () => {
  let directory = '';
  let ledgerPath = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'overtime-workflow-'));
    ledgerPath = join(directory, 'ledger.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('durably accepts an application once and atomically enqueues routing', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    const first = await store.acceptApplication({
      clientMutationId: 'overtime-request-1',
      snapshot: SNAPSHOT,
    });
    const replay = await store.acceptApplication({
      clientMutationId: 'overtime-request-1',
      snapshot: SNAPSHOT,
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect((await store.listTasks()).map((entry) => entry.businessKey)).toEqual(
      ['overtime:rec_overtime_1:route'],
    );
    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8'));
    expect(persisted.applications).toHaveLength(1);
    expect(persisted.applications[0].approvalCardPatches).toEqual([]);
    expect(persisted.applications[0].confirmationResultCards).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('atomically retires a deleted source record and its unfinished tasks', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-deleted-source',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication(SNAPSHOT.recordId, {
      phase: 'awaiting_confirmation',
      actualApproverOpenId: 'ou_approver_1',
      approvalCards: [
        {
          recipientOpenId: 'ou_approver_1',
          messageId: 'om_deleted_approval',
          businessKey: 'overtime:rec_overtime_1:approval:ou_approver_1',
        },
      ],
      confirmationCards: [
        {
          recipientOpenId: 'ou_approver_1',
          messageId: 'om_deleted_confirmation',
          businessKey: 'overtime-confirm:rec_overtime_1:initial',
        },
      ],
    });
    await store.enqueueDailyConfirmationReminder(
      SNAPSHOT.recordId,
      'ou_approver_1',
      new Date('2026-08-14T00:00:00.000Z'),
    );

    const retired = await store.markSourceDeleted(
      SNAPSHOT.recordId,
      new Date('2026-08-14T00:01:00.000Z'),
    );

    expect(retired).toEqual(
      expect.objectContaining({
        phase: 'source_deleted',
        sourceDeletedAt: '2026-08-14T00:01:00.000Z',
        sourceDeletedCardPatches: [],
      }),
    );
    expect(
      (await store.listTasks()).filter(
        (task) =>
          task.recordId === SNAPSHOT.recordId &&
          ['pending', 'processing'].includes(task.status),
      ),
    ).toEqual([]);
    expect(
      (await store.listTasks()).filter(
        (task) => task.recordId === SNAPSHOT.recordId,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'completed',
          lastError: expect.stringContaining('底表记录已删除'),
        }),
      ]),
    );

    await store.markSourceDeletedCardPatched(
      SNAPSHOT.recordId,
      'om_deleted_approval',
      new Date('2026-08-14T00:02:00.000Z'),
    );
    await store.markSourceDeletedCardPatched(
      SNAPSHOT.recordId,
      'om_deleted_confirmation',
      new Date('2026-08-14T00:02:00.000Z'),
    );
    await store.markSourceDeletedCardPatched(
      SNAPSHOT.recordId,
      'om_deleted_confirmation',
      new Date('2026-08-14T00:03:00.000Z'),
    );
    expect(
      (
        await store.getApplication(SNAPSHOT.recordId)
      )?.sourceDeletedCardPatches.map((entry) => entry.messageId),
    ).toEqual(['om_deleted_approval', 'om_deleted_confirmation']);
  });

  it('recovers a missing confirmation application from the legacy in-release ledger after an upgrade', async () => {
    const legacyLedgerPath = join(directory, 'legacy', 'ledger.json');
    const durableLedgerPath = join(directory, 'durable', 'ledger.json');
    const legacy = new OvertimeWorkflowStore(legacyLedgerPath);
    await legacy.acceptApplication({
      clientMutationId: 'legacy-overtime-request',
      snapshot: SNAPSHOT,
    });
    await legacy.patchApplication(SNAPSHOT.recordId, {
      phase: 'awaiting_confirmation',
      actualApproverOpenId: 'ou_approver_1',
      actualApproverName: '旧审批人',
      confirmationCards: [
        {
          recipientOpenId: 'ou_approver_1',
          messageId: 'om_legacy_confirmation',
          businessKey: 'overtime-confirm:rec_overtime_1:initial',
        },
      ],
    });

    const durable = new OvertimeWorkflowStore(durableLedgerPath);
    await durable.acceptApplication({
      clientMutationId: 'current-overtime-request',
      snapshot: {
        ...SNAPSHOT,
        recordId: 'rec_current_overtime',
        applicantName: '当前申请人',
      },
    });

    const restarted = new OvertimeWorkflowStore(
      durableLedgerPath,
      legacyLedgerPath,
    );
    await expect(restarted.getApplication(SNAPSHOT.recordId)).resolves.toEqual(
      expect.objectContaining({
        recordId: SNAPSHOT.recordId,
        phase: 'awaiting_confirmation',
        actualApproverOpenId: 'ou_approver_1',
        confirmationCards: [
          expect.objectContaining({ messageId: 'om_legacy_confirmation' }),
        ],
      }),
    );
    expect(
      (await restarted.listApplications())
        .map((entry) => entry.recordId)
        .sort(),
    ).toEqual(['rec_current_overtime', SNAPSHOT.recordId].sort());
    expect(
      (await restarted.listTasks()).map((entry) => entry.recordId).sort(),
    ).toEqual(['rec_current_overtime', SNAPSHOT.recordId].sort());

    const persisted = JSON.parse(await readFile(durableLedgerPath, 'utf8'));
    expect(persisted.applications).toHaveLength(2);
    expect(
      JSON.parse(await readFile(legacyLedgerPath, 'utf8')).applications,
    ).toHaveLength(1);
  });

  it('rejects a mutation replay whose payload changed', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-1',
      snapshot: SNAPSHOT,
    });
    await expect(
      store.acceptApplication({
        clientMutationId: 'overtime-request-1',
        snapshot: { ...SNAPSHOT, plannedHours: 4 },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('recovers processing work on startup and applies bounded exponential retry', async () => {
    const first = new OvertimeWorkflowStore(ledgerPath);
    await first.acceptApplication(
      {
        clientMutationId: 'overtime-request-1',
        snapshot: SNAPSHOT,
      },
      new Date('2026-08-11T23:59:00.000Z'),
    );
    const leased = await first.takeNextTask(
      new Date('2026-08-12T00:00:00.000Z'),
      60_000,
    );
    expect(leased?.status).toBe('processing');

    const restarted = new OvertimeWorkflowStore(ledgerPath);
    await restarted.onModuleInit(new Date('2026-08-12T00:00:01.000Z'));
    const recovered = await restarted.takeNextTask(
      new Date('2026-08-12T00:00:01.000Z'),
      60_000,
    );
    expect(recovered?.key).toBe(leased?.key);
    const retried = await restarted.rescheduleTask(
      recovered!.key,
      recovered!.claimToken,
      new Error('Bearer secret-token app_secret=hidden'),
      new Date('2026-08-12T00:00:02.000Z'),
    );
    expect(retried?.status).toBe('pending');
    expect(Date.parse(retried!.nextAttemptAt)).toBeGreaterThan(
      Date.parse(retried!.updatedAt),
    );
    expect(retried?.lastError).toContain('[redacted]');
    expect(retried?.lastError).not.toContain('secret-token');
    expect(retried?.lastError).not.toContain('hidden');
  });

  it('keeps core work recoverable after the former eight-attempt limit', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication(
      {
        clientMutationId: 'overtime-request-1',
        snapshot: SNAPSHOT,
      },
      new Date('2026-08-12T00:00:00.000Z'),
    );
    let now = new Date('2026-08-12T00:00:00.000Z');
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const task = await store.takeNextTask(now);
      expect(task).not.toBeNull();
      const retried = await store.rescheduleTask(
        task!.key,
        task!.claimToken,
        new Error('temporary Feishu outage'),
        now,
        Number.POSITIVE_INFINITY,
      );
      expect(retried?.status).toBe('pending');
      now = new Date(retried!.nextAttemptAt);
    }
    const recovered = await store.takeNextTask(now);
    expect(recovered?.attempts).toBe(10);
    await store.completeTask(recovered!.key, recovered!.claimToken, now);
    expect((await store.getTask(recovered!.key))?.status).toBe('completed');
  }, 15_000);

  it('reclaims only terminal tasks older than 30 days before enforcing capacity', async () => {
    const old = '2026-06-01T00:00:00.000Z';
    const tasks = Array.from({ length: 5_000 }, (_, index) => ({
      key: `task:old-${index}`,
      businessKey: `old:${index}`,
      recordId: 'rec_capacity',
      kind: 'route_application',
      payload: {},
      messageUuid: `ow_old_${index}`,
      status: 'completed',
      attempts: 1,
      createdAt: old,
      updatedAt: old,
      nextAttemptAt: old,
      leaseUntil: '',
      claimToken: '',
      completedAt: old,
      lastError: '',
    }));
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 1,
        applications: [],
        tasks,
        approvalActions: [],
        confirmations: [],
      }),
      'utf8',
    );
    const store = new OvertimeWorkflowStore(ledgerPath);
    const created = await store.enqueueTask(
      {
        businessKey: 'current:route',
        recordId: 'rec_capacity',
        kind: 'route_application',
      },
      new Date('2026-08-12T00:00:00.000Z'),
    );
    expect(created.created).toBe(true);
    expect((await store.listTasks()).map((task) => task.businessKey)).toEqual([
      'current:route',
    ]);
  });

  it('lets the first authorized approval action win atomically', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-1',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'approval_pending',
      approvers: [
        {
          name: '示例人员009',
          openId: 'ou_approver_1',
          position: '示例人员001',
          buildings: ['A楼'],
        },
        {
          name: '示例人员014',
          openId: 'ou_approver_2',
          position: '经理',
          buildings: [],
        },
      ],
      approvalCards: [
        {
          recipientOpenId: 'ou_approver_1',
          messageId: 'om_1',
          businessKey: 'overtime:rec_overtime_1:approval:ou_approver_1',
        },
        {
          recipientOpenId: 'ou_approver_2',
          messageId: 'om_2',
          businessKey: 'overtime:rec_overtime_1:approval:ou_approver_2',
        },
      ],
    });

    await expect(
      store.claimApprovalAction({
        eventId: 'evt_bad',
        recordId: 'rec_overtime_1',
        action: 'approve',
        actorOpenId: 'ou_intruder',
        messageId: 'om_bad',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const first = await Promise.all([
      store.claimApprovalAction({
        eventId: 'evt_1',
        recordId: 'rec_overtime_1',
        action: 'approve',
        actorOpenId: 'ou_approver_1',
        messageId: 'om_1',
      }),
      store.claimApprovalAction({
        eventId: 'evt_2',
        recordId: 'rec_overtime_1',
        action: 'reject',
        actorOpenId: 'ou_approver_2',
        messageId: 'om_2',
      }),
    ]);
    expect(first.filter((entry) => entry.claimed)).toHaveLength(1);
    expect(
      (await store.listTasks()).filter(
        (entry) => entry.kind === 'apply_approval',
      ),
    ).toHaveLength(1);
  });

  it('returns the existing terminal decision to another delivered approver card', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-terminal-replay',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'approval_pending',
      approvers: [
        {
          name: '示例人员009',
          openId: 'ou_approver_1',
          position: '示例人员001',
          buildings: ['A楼'],
        },
        {
          name: '示例人员014',
          openId: 'ou_approver_2',
          position: '经理',
          buildings: [],
        },
      ],
      approvalCards: [
        {
          recipientOpenId: 'ou_approver_1',
          messageId: 'om_terminal_1',
          businessKey: 'overtime:rec_overtime_1:approval:ou_approver_1',
        },
        {
          recipientOpenId: 'ou_approver_2',
          messageId: 'om_terminal_2',
          businessKey: 'overtime:rec_overtime_1:approval:ou_approver_2',
        },
      ],
    });
    const first = await store.claimApprovalAction({
      eventId: 'evt_terminal_first',
      recordId: 'rec_overtime_1',
      action: 'approve',
      actorOpenId: 'ou_approver_1',
      messageId: 'om_terminal_1',
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'awaiting_confirmation',
    });

    await expect(
      store.claimApprovalAction({
        eventId: 'evt_terminal_second',
        recordId: 'rec_overtime_1',
        action: 'reject',
        actorOpenId: 'ou_approver_2',
        messageId: 'om_terminal_2',
      }),
    ).resolves.toEqual({ claimed: false, entry: first.entry });
  });

  it('rejects approval actions from the wrong phase or an unmatched delivered card', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-1',
      snapshot: SNAPSHOT,
    });
    const approver = {
      name: '示例人员009',
      openId: 'ou_approver_1',
      position: '示例人员001',
      buildings: ['A楼'],
    };
    const delivery = {
      recipientOpenId: approver.openId,
      messageId: 'om_delivered_1',
      businessKey: 'overtime:rec_overtime_1:approval:ou_approver_1',
    };
    await store.patchApplication('rec_overtime_1', {
      approvers: [approver],
      approvalCards: [delivery],
    });

    await expect(
      store.claimApprovalAction({
        eventId: 'evt_wrong_phase',
        recordId: 'rec_overtime_1',
        action: 'approve',
        actorOpenId: approver.openId,
        messageId: delivery.messageId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    await store.patchApplication('rec_overtime_1', {
      phase: 'approval_pending',
      approvalCards: [],
    });
    await expect(
      store.claimApprovalAction({
        eventId: 'evt_not_delivered',
        recordId: 'rec_overtime_1',
        action: 'approve',
        actorOpenId: approver.openId,
        messageId: delivery.messageId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await store.patchApplication('rec_overtime_1', {
      approvalCards: [delivery],
    });
    await expect(
      store.claimApprovalAction({
        eventId: 'evt_wrong_message',
        recordId: 'rec_overtime_1',
        action: 'approve',
        actorOpenId: approver.openId,
        messageId: 'om_different_card',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      (await store.listTasks()).filter(
        (task) => task.kind === 'apply_approval',
      ),
    ).toHaveLength(0);
  });

  it('keeps the exact confirmation draft and deduplicates mutation replays', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-1',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'awaiting_confirmation',
      actualApproverOpenId: 'ou_approver_1',
    });
    const draft = {
      actualStartAt: '2026-08-13T09:30:00+08:00',
      actualHours: 7,
      disposition: '调休' as const,
    };
    const first = await store.claimConfirmationSubmission({
      mutationId: 'confirm-1',
      recordId: 'rec_overtime_1',
      actorOpenId: 'ou_approver_1',
      draft,
    });
    const replay = await store.claimConfirmationSubmission({
      mutationId: 'confirm-1',
      recordId: 'rec_overtime_1',
      actorOpenId: 'ou_approver_1',
      draft,
    });
    expect(first.claimed).toBe(true);
    expect(replay.claimed).toBe(false);
    expect(replay.entry.draft).toEqual(draft);
    await expect(
      store.claimConfirmationSubmission({
        mutationId: 'confirm-1',
        recordId: 'rec_overtime_1',
        actorOpenId: 'ou_approver_1',
        draft: { ...draft, actualHours: 8 },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.claimConfirmationSubmission({
        mutationId: 'confirm-2',
        recordId: 'rec_overtime_1',
        actorOpenId: 'ou_approver_1',
        draft: { ...draft, actualHours: 8 },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows only an exact confirmation replay after the application is confirmed', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-confirmed-replay',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'awaiting_confirmation',
      actualApproverOpenId: 'ou_approver_1',
    });
    const submission = {
      mutationId: 'confirm-replay-after-confirmed',
      recordId: 'rec_overtime_1',
      actorOpenId: 'ou_approver_1',
      draft: {
        actualStartAt: '2026-08-13T09:00:00+08:00',
        actualHours: 8,
        disposition: '调休' as const,
      },
    };
    await store.claimConfirmationSubmission(submission);
    await store.patchApplication('rec_overtime_1', { phase: 'confirmed' });
    const taskCount = (await store.listTasks()).length;

    await expect(
      store.claimConfirmationSubmission(submission),
    ).resolves.toEqual(expect.objectContaining({ claimed: false }));
    await expect(
      store.claimConfirmationSubmission({
        ...submission,
        mutationId: 'confirm-different-after-confirmed',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      store.claimConfirmationSubmission({
        ...submission,
        draft: { ...submission.draft, actualHours: 7 },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await store.listTasks()).toHaveLength(taskCount);
  });

  it('rejects a new confirmation claim unless the application awaits confirmation', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-invalid-confirmation-phase',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'approved',
      actualApproverOpenId: 'ou_approver_1',
    });

    await expect(
      store.claimConfirmationSubmission({
        mutationId: 'confirm-invalid-phase',
        recordId: 'rec_overtime_1',
        actorOpenId: 'ou_approver_1',
        draft: {
          actualStartAt: '2026-08-13T09:00:00+08:00',
          actualHours: 8,
          disposition: '调休',
        },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await store.listTasks()).filter(
        (task) => task.kind === 'apply_confirmation',
      ),
    ).toHaveLength(0);
  });

  it('accepts a zero-hour confirmation only when disposition is null', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-zero-hour',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'awaiting_confirmation',
      actualApproverOpenId: 'ou_approver_1',
    });

    const accepted = await store.claimConfirmationSubmission({
      mutationId: 'confirm-zero-hour',
      recordId: 'rec_overtime_1',
      actorOpenId: 'ou_approver_1',
      draft: {
        actualStartAt: '2026-08-13T09:00:00+08:00',
        actualHours: 0,
        disposition: null,
      },
    } as never);

    expect(accepted.entry.draft).toEqual({
      actualStartAt: '2026-08-13T09:00:00+08:00',
      actualHours: 0,
      disposition: null,
    });
  });

  it('rejects zero hours with a disposition and positive hours without one', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-invalid-disposition',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'awaiting_confirmation',
      actualApproverOpenId: 'ou_approver_1',
    });

    await expect(
      store.claimConfirmationSubmission({
        mutationId: 'confirm-zero-with-disposition',
        recordId: 'rec_overtime_1',
        actorOpenId: 'ou_approver_1',
        draft: {
          actualStartAt: '2026-08-13T09:00:00+08:00',
          actualHours: 0,
          disposition: '调休',
        },
      }),
    ).rejects.toThrow('0 工时无需选择加班工时处置方式');
    await expect(
      store.claimConfirmationSubmission({
        mutationId: 'confirm-positive-without-disposition',
        recordId: 'rec_overtime_1',
        actorOpenId: 'ou_approver_1',
        draft: {
          actualStartAt: '2026-08-13T09:00:00+08:00',
          actualHours: 1,
          disposition: null,
        },
      } as never),
    ).rejects.toThrow('请选择加班工时处置方式');
  });

  it('does not coerce a null hour value into a zero-hour cancellation', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    await store.acceptApplication({
      clientMutationId: 'overtime-request-null-hours',
      snapshot: SNAPSHOT,
    });
    await store.patchApplication('rec_overtime_1', {
      phase: 'awaiting_confirmation',
      actualApproverOpenId: 'ou_approver_1',
    });

    await expect(
      store.claimConfirmationSubmission({
        mutationId: 'confirm-null-hours',
        recordId: 'rec_overtime_1',
        actorOpenId: 'ou_approver_1',
        draft: {
          actualStartAt: '2026-08-13T09:00:00+08:00',
          actualHours: null,
          disposition: null,
        },
      } as never),
    ).rejects.toThrow('实际加班工时必须是 0 至 72 的整数');
  });

  it('migrates an old ledger without card patch and confirmation result ledgers', async () => {
    const original = new OvertimeWorkflowStore(ledgerPath);
    await original.acceptApplication({
      clientMutationId: 'overtime-request-old-ledger',
      snapshot: SNAPSHOT,
    });
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      applications: Array<Record<string, unknown>>;
    };
    delete ledger.applications[0].approvalCardPatches;
    delete ledger.applications[0].confirmationResultCards;
    delete ledger.applications[0].confirmationResultIntents;
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');

    const restarted = new OvertimeWorkflowStore(ledgerPath);
    expect(
      (
        (await restarted.getApplication(SNAPSHOT.recordId)) as unknown as {
          approvalCardPatches: unknown[];
        }
      ).approvalCardPatches,
    ).toEqual([]);
    expect(
      (await restarted.getApplication(SNAPSHOT.recordId))
        ?.confirmationResultCards,
    ).toEqual([]);
    expect(
      (await restarted.getApplication(SNAPSHOT.recordId))
        ?.confirmationResultIntents,
    ).toEqual([]);
  });

  it('rejects malformed, duplicate or foreign approval card patch ledgers', async () => {
    const original = new OvertimeWorkflowStore(ledgerPath);
    await original.acceptApplication({
      clientMutationId: 'overtime-request-strict-approval-patch-ledger',
      snapshot: SNAPSHOT,
    });
    await original.patchApplication(SNAPSHOT.recordId, {
      approvalCards: [
        {
          recipientOpenId: 'ou_approver_1',
          messageId: 'om_approval_1',
          businessKey: `overtime:${SNAPSHOT.recordId}:approval:ou_approver_1`,
        },
      ],
    });
    const pristine = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      applications: Array<Record<string, unknown>>;
    };
    const cases: unknown[] = [
      { damaged: true },
      [{ messageId: '', patchedAt: '2026-08-14T00:00:00.000Z' }],
      [{ messageId: 'om_approval_1', patchedAt: 'not-a-date' }],
      [{ messageId: 'om_foreign', patchedAt: '2026-08-14T00:00:00.000Z' }],
      [
        {
          messageId: 'om_approval_1',
          patchedAt: '2026-08-14T00:00:00.000Z',
        },
        {
          messageId: 'om_approval_1',
          patchedAt: '2026-08-14T00:00:01.000Z',
        },
      ],
    ];

    for (const approvalCardPatches of cases) {
      const damaged = JSON.parse(JSON.stringify(pristine)) as {
        applications: Array<Record<string, unknown>>;
      };
      damaged.applications[0].approvalCardPatches = approvalCardPatches;
      await writeFile(ledgerPath, JSON.stringify(damaged), 'utf8');
      await expect(
        new OvertimeWorkflowStore(ledgerPath).getApplication(SNAPSHOT.recordId),
      ).rejects.toThrow('approvalCardPatches');
    }
  });

  it('rejects malformed confirmation result ledgers and deduplicates valid arrays by business key', async () => {
    const original = new OvertimeWorkflowStore(ledgerPath);
    await original.acceptApplication({
      clientMutationId: 'overtime-request-strict-result-ledger',
      snapshot: SNAPSHOT,
    });
    const readLedger = async () =>
      JSON.parse(await readFile(ledgerPath, 'utf8')) as {
        applications: Array<Record<string, unknown>>;
      };

    let ledger = await readLedger();
    ledger.applications[0].confirmationResultCards = { damaged: true };
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');
    await expect(
      new OvertimeWorkflowStore(ledgerPath).getApplication(SNAPSHOT.recordId),
    ).rejects.toThrow('confirmationResultCards');

    ledger = await readLedger();
    ledger.applications[0].confirmationResultCards = [
      {
        recipientOpenId: 'not-an-open-id',
        messageId: 'om_invalid',
        businessKey: 'result:invalid',
      },
    ];
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');
    await expect(
      new OvertimeWorkflowStore(ledgerPath).getApplication(SNAPSHOT.recordId),
    ).rejects.toThrow('confirmationResultCards');

    ledger = await readLedger();
    ledger.applications[0].confirmationResultCards = [];
    ledger.applications[0].confirmationResultIntents = [{ damaged: true }];
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');
    await expect(
      new OvertimeWorkflowStore(ledgerPath).getApplication(SNAPSHOT.recordId),
    ).rejects.toThrow('confirmationResultIntents');

    ledger = await readLedger();
    ledger.applications[0].confirmationResultCards = [
      {
        recipientOpenId: 'ou_applicant',
        messageId: 'om_old',
        businessKey: 'result:applicant',
      },
      {
        recipientOpenId: 'ou_applicant',
        messageId: 'om_latest',
        businessKey: 'result:applicant',
      },
    ];
    ledger.applications[0].confirmationResultIntents = [
      {
        recipientOpenId: 'ou_applicant',
        businessKey: 'result:applicant',
        messageUuid: stableOvertimeMessageUuid('result:applicant'),
        createdAt: '2026-08-14T00:00:00.000Z',
      },
      {
        recipientOpenId: 'ou_applicant',
        businessKey: 'result:applicant',
        messageUuid: stableOvertimeMessageUuid('result:applicant'),
        createdAt: '2026-08-14T00:00:00.000Z',
      },
    ];
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');
    const restarted = new OvertimeWorkflowStore(ledgerPath);
    expect(
      (await restarted.getApplication(SNAPSHOT.recordId))
        ?.confirmationResultCards,
    ).toEqual([
      {
        recipientOpenId: 'ou_applicant',
        messageId: 'om_latest',
        businessKey: 'result:applicant',
      },
    ]);
    expect(
      (await restarted.getApplication(SNAPSHOT.recordId))
        ?.confirmationResultIntents,
    ).toHaveLength(1);
  });

  it('deduplicates confirmation reminders by Shanghai calendar date', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    const first = await store.enqueueDailyConfirmationReminder(
      'rec_overtime_1',
      'ou_approver_1',
      new Date('2026-08-12T15:59:59.000Z'),
    );
    const replay = await store.enqueueDailyConfirmationReminder(
      'rec_overtime_1',
      'ou_approver_1',
      new Date('2026-08-12T15:59:59.500Z'),
    );
    const nextDay = await store.enqueueDailyConfirmationReminder(
      'rec_overtime_1',
      'ou_approver_1',
      new Date('2026-08-12T16:00:00.000Z'),
    );
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(nextDay.created).toBe(true);
    expect(first.task.businessKey).toContain('2026-08-12');
    expect(nextDay.task.businessKey).toContain('2026-08-13');
  });

  it('keeps the initial due confirmation task separate from daily reminder keys', async () => {
    const store = new OvertimeWorkflowStore(ledgerPath);
    const initial = await store.enqueueInitialConfirmationReminder(
      'rec_overtime_1',
      'ou_approver_1',
      '2026-08-13T17:00:00+08:00',
      new Date('2026-08-12T00:00:00.000Z'),
    );
    const replay = await store.enqueueInitialConfirmationReminder(
      'rec_overtime_1',
      'ou_approver_1',
      '2026-08-13T17:00:00+08:00',
      new Date('2026-08-12T00:01:00.000Z'),
    );
    const daily = await store.enqueueDailyConfirmationReminder(
      'rec_overtime_1',
      'ou_approver_1',
      new Date('2026-08-14T01:00:00.000Z'),
    );
    expect(initial.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(initial.task.businessKey).toBe(
      'overtime-confirm:rec_overtime_1:initial',
    );
    expect(initial.task.nextAttemptAt).toBe('2026-08-13T09:00:00.000Z');
    expect(daily.task.businessKey).toBe(
      'overtime-confirm:rec_overtime_1:2026-08-14',
    );
  });
});
