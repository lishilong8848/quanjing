import {
  LeaveWorkflowService as ActualLeaveWorkflowService,
  buildShiftAssignmentSummary,
} from './leave-workflow.service';
import { LeaveWorkflowStore } from './leave-workflow.store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleLogger } from '@nestjs/common';

class LeaveWorkflowService extends ActualLeaveWorkflowService {
  constructor(...args: ConstructorParameters<typeof ActualLeaveWorkflowService>) {
    super(args[0], args[1], args[2], args[3], { canUseFeishuBusinessIdentity: () => true } as never);
  }
}

describe('LeaveWorkflowService', () => {
  jest.setTimeout(15_000);
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED = 'true';
    process.env.FEISHU_APP_ID = 'cli_synthetic_leave_service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('enables the program-card leave workflow when the flag is unset', () => {
    delete process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED;
    const service = new LeaveWorkflowService(
      {} as never,
      {} as never,
      {} as never,
    );

    expect(service.isEnabled()).toBe(true);
  });

  it('starts retry backoff after slow failure reporting finishes, preventing immediate timeout loops', async () => {
    let clock = 1000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const store = {
      takeNextTask: jest.fn().mockResolvedValue({ key: 'route', recordId: 'rec_leave', kind: 'route_application', claimToken: 'claim' }),
      rescheduleTask: jest.fn(),
    };
    const service = new LeaveWorkflowService(store as never, {} as never, {} as never);
    jest.spyOn(service as any, 'processTask').mockImplementation(async () => {
      clock += 15_000;
      throw new Error('timeout of 15000ms exceeded');
    });
    jest.spyOn(service as any, 'recordTaskFailure').mockImplementation(async () => { clock += 15_000; });
    try {
      await expect(service.runPendingTasks(new Date(1000), 1)).resolves.toEqual({ processed: 0, failed: 1 });
      expect(store.rescheduleTask.mock.calls[0][3].getTime()).toBe(31_000);
    } finally { now.mockRestore(); }
  });

  it('wakes the scheduler only after the acceptance and route task are persisted', async () => {
    let persist!: (value: unknown) => void;
    const store = { acceptApplication: jest.fn(() => new Promise(resolve => { persist = resolve; })) };
    const service = new LeaveWorkflowService(store as never, {} as never, {} as never);
    const wake = jest.fn();
    service.setTaskWakeHandler(wake);
    const accepted = service.acceptApplications({
      clientMutationId: 'wake-after-persist', recordIds: ['rec_wake'], leaveStaffName: '示例人员008',
      startAt: '2026-08-17T09:00:00+08:00', endAt: '2026-08-17T18:00:00+08:00',
      leaveType: '年假', leaveHours: 8, approvalDayCount: 1, reason: '测试',
    });
    expect(wake).not.toHaveBeenCalled();
    persist({ created: true });
    await accepted;
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('records the completion clock after task claim and execution rather than their start', async () => {
    let clock = 1000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const store = {
      takeNextTask: jest.fn().mockImplementation(async () => { clock += 500; return { key: 'detail', recordId: 'rec_leave', kind: 'sync_leave_shift_details', claimToken: 'claim' }; }),
      completeTask: jest.fn(),
    };
    const service = new LeaveWorkflowService(store as never, {} as never, {} as never);
    jest.spyOn(service as any, 'processTask').mockImplementation(async () => { clock += 1500; });
    try {
      await expect(service.runPendingTasks(new Date(1000), 1)).resolves.toEqual({ processed: 1, failed: 0 });
      expect(store.completeTask.mock.calls[0][2].getTime()).toBe(3000);
    } finally { now.mockRestore(); }
  });

  it.each([200, 2800])('keeps slow acceptance timing visible with production warn/error logging (%i ms)', async duration => {
    let clock = 1000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const store = { claimStageAction: jest.fn(async () => { clock += duration; return { accepted: true, entry: { recordId: 'rec_slow_test' }, action: null }; }) };
    const service = new LeaveWorkflowService(store as never, {} as never, {} as never);
    const logger = new ConsoleLogger('TEST', { logLevels: ['warn', 'error'] });
    (service as any).logger = logger;
    jest.spyOn(service as any, 'stageActionCard').mockReturnValue({});
    const output = jest.spyOn(logger as any, 'printMessages').mockImplementation(() => {});
    try {
      await service.acceptApprovalAction({ recordId: 'rec_slow_test', stageKey: 'supervisor', stageVersion: 1, action: 'reject', eventId: 'test-timing', actorOpenId: 'ou_actor', rejectionReason: 'PRIVATE_DO_NOT_LOG' });
      const text = JSON.stringify(output.mock.calls);
      if (duration >= 1000) expect(text).toContain(`commitMs=${duration}`);
      else expect(output).not.toHaveBeenCalled();
      expect(text).not.toContain('PRIVATE_DO_NOT_LOG');
      expect(text).not.toContain('ou_actor');
    } finally { now.mockRestore(); output.mockRestore(); }
  });

  it('hydrates missing long-white shift groups from the authoritative schedule cache', async () => {
    const bitableSync = {
      getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'schedule_long_white',
          scheduleDate: '2026-08-26',
          building: 'B',
          buildingText: 'B',
          team: 'long_white',
          teamText: 'long_white',
          shift: 'long_white',
          shiftText: 'long_white',
          dutyStaffActual: ['Season'],
        },
      ]),
    };
    const service = new LeaveWorkflowService(
      {} as never,
      {} as never,
      bitableSync as never,
    );

    const snapshot = await (service as any).hydrateMissingShiftGroups({
      applicantName: 'Season',
      applicantOpenId: 'ou_season',
      applicantPersonRecordId: 'rec_season',
      applicantNotificationOpenIds: [],
      building: 'B',
      position: 'engineer',
      leaveType: 'annual',
      startAt: '2026-08-26T01:00:00.000Z',
      endAt: '2026-08-26T10:00:00.000Z',
      leaveHours: 8,
      approvalDayCount: 1,
      reason: 'exam',
      shiftGroups: [],
    });

    expect(snapshot.shiftGroups).toEqual([
      expect.objectContaining({
        kind: 'long_white',
        scheduleRecordIds: ['schedule_long_white'],
      }),
    ]);
  });

  it('accepts one atomic substitute mapping for two actual shifts', async () => {
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
    const application = {
      key: 'leave:rec_leave_multi',
      recordId: 'rec_leave_multi',
      snapshot: {
        applicantName: '示例人员012',
        applicantOpenId: 'ou_cao',
        applicantPersonRecordId: 'rec_cao',
        applicantNotificationOpenIds: ['ou_cao'],
        building: 'A楼',
        position: '运维值班员',
        leaveType: '年假',
        startAt: '2026-08-26T09:00:00+08:00',
        endAt: '2026-08-28T09:00:00+08:00',
        leaveHours: 23,
        approvalDayCount: 2,
        reason: '连续请假',
        substituteRequired: true,
        shiftGroups,
        shiftAssignments: [],
        assignmentRevision: 0,
      },
      status: 'supervisor_pending',
      currentStage: { key: 'supervisor', version: 1, approverOpenIds: ['ou_supervisor'] },
      resolvedByName: '',
      rejectionReason: '',
    };
    const store = {
      getApplication: jest.fn().mockResolvedValue(application),
      claimStageAction: jest.fn(async (input) => ({
        accepted: true,
        reason: 'accepted',
        entry: {
          ...application,
          status: 'approved_syncing',
          snapshot: {
            ...application.snapshot,
            shiftAssignments: input.shiftAssignments,
          },
        },
        action: { actorName: '示例人员001', rejectionReason: '' },
      })),
    };
    const personnel = [
      {
        recordId: 'rec_cao',
        name: '示例人员012',
        openId: 'ou_cao',
        position: '运维值班员',
        buildings: ['A楼'],
      },
      {
        recordId: 'rec_zhang',
        name: '示例人员008',
        openId: 'ou_zhang',
        position: '运维值班员',
        buildings: ['A楼'],
      },
      {
        recordId: 'rec_li',
        name: '示例人员013',
        openId: 'ou_li',
        position: '运维值班员',
        buildings: ['B楼'],
      },
    ];
    const bitable = {
      getCachedActivePersonnelDirectory: jest.fn().mockResolvedValue({
        personnel,
        selectablePersonnel: personnel,
      }),
      getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'schedule_1',
          scheduleDate: '2026-08-26',
          building: 'A楼',
          team: '一班',
          shift: '白班',
          dutyStaffActual: ['示例人员012'],
        },
        {
          recordId: 'schedule_2',
          scheduleDate: '2026-08-27',
          building: 'B楼',
          team: '二班',
          shift: '夜班',
          dutyStaffActual: ['示例人员012'],
        },
      ]),
    };
    const service = new LeaveWorkflowService(
      store as never,
      {} as never,
      bitable as never,
    );

    const result = await service.acceptApprovalAction({
      eventId: 'evt_multi_approve',
      recordId: 'rec_leave_multi',
      stageKey: 'supervisor',
      stageVersion: 1,
      actorOpenId: 'ou_supervisor',
      actorName: '示例人员001',
      action: 'approve',
      messageId: 'om_multi_approve',
      shiftSelections: [
        {
          shiftKey: shiftGroups[0].shiftKey,
          substitutePersonRecordId: 'rec_zhang',
        },
        {
          shiftKey: shiftGroups[1].shiftKey,
          substitutePersonRecordId: 'rec_li',
        },
      ],
    });

    expect(result.claimed).toBe(true);
    expect(JSON.stringify(result.card)).toContain('已受理');
    expect(store.claimStageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        shiftAssignments: [
          expect.objectContaining({
            shiftKey: shiftGroups[0].shiftKey,
            substitutePersonRecordId: 'rec_zhang',
          }),
          expect.objectContaining({
            shiftKey: shiftGroups[1].shiftKey,
            substitutePersonRecordId: 'rec_li',
          }),
        ],
      }),
    );
    expect(
      buildShiftAssignmentSummary(
        store.claimStageAction.mock.calls[0][0].shiftAssignments,
      ),
    ).toBe(
      '2026-08-26 白班 09:00–18:00：示例人员008\n2026-08-27 夜班 18:00–09:00：示例人员013',
    );
  });

  it('recovers exact orphaned frontend leave records idempotently', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-recovery-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const gateway = {
      findLeaveRecordsByCodes: jest.fn().mockResolvedValue([
        {
          recordId: 'rec_leave_920',
          fields: {
            休假编号: 'XJ-920-刘小杏',
            请求唯一ID: 'leave-request-liuxiaoxing-920',
            '休假人员姓名（程序）': '刘小杏',
            休假开始时间: Date.parse('2026-08-20T09:00:00+08:00'),
            休假结束时间: Date.parse('2026-08-20T18:00:00+08:00'),
            休假类型: '调休',
            休假工时数: 8,
            休假天数: 1,
            请假原因: '临时调休',
          },
        },
        {
          recordId: 'rec_leave_921',
          fields: {
            休假编号: 'XJ-921-刘小杏',
            请求唯一ID: 'leave-request-liuxiaoxing-921',
            休假人员: '刘小杏',
            休假开始时间: Date.parse('2026-08-19T09:00:00+08:00'),
            休假结束时间: Date.parse('2026-08-19T18:00:00+08:00'),
            休假类型: '年假',
            休假工时数: 8,
            休假天数: 1,
            请假原因: '年假',
          },
        },
      ]),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      {} as never,
    );

    try {
      const first = await service.recoverApplicationsByLeaveCodes([
        'XJ-920-刘小杏',
        'XJ-921-刘小杏',
      ]);
      const second = await service.recoverApplicationsByLeaveCodes([
        'XJ-920-刘小杏',
        'XJ-921-刘小杏',
      ]);

      expect(first).toEqual({
        requestedCodes: ['XJ-920-刘小杏', 'XJ-921-刘小杏'],
        matchedCodes: ['XJ-920-刘小杏', 'XJ-921-刘小杏'],
        missingCodes: [],
        created: 2,
        existing: 0,
      });
      expect(second).toEqual(
        expect.objectContaining({
          created: 0,
          existing: 2,
          missingCodes: [],
        }),
      );
      await expect(store.listApplications()).resolves.toHaveLength(2);
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('accepts an official leave record without waiting for external routing', async () => {
    const store = {
      acceptApplication: jest.fn().mockResolvedValue({ created: true }),
    };
    const service = new LeaveWorkflowService(
      store as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.acceptApplications({
        clientMutationId: 'leave-mutation-1',
        recordIds: ['rec_leave_1'],
        leaveStaffName: '示例人员008',
        startAt: '2026-08-17T09:00:00+08:00',
        endAt: '2026-08-17T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '测试',
      }),
    ).resolves.toEqual({
      accepted: true,
      created: 1,
      recordIds: ['rec_leave_1'],
    });
    expect(store.acceptApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMutationId: 'leave-mutation-1:rec_leave_1',
        recordId: 'rec_leave_1',
      }),
    );
  });

  it('routes when the legacy-workflow mutual-exclusion flag is absent', async () => {
    delete process.env.LEAVE_WORKFLOW_LEGACY_MUTUAL_EXCLUSION_READY;
    const store = {
      acceptApplication: jest.fn().mockResolvedValue({ created: true }),
    };
    const service = new LeaveWorkflowService(
      store as never,
      {} as never,
      {} as never,
    );

    expect(service.isEnabled()).toBe(true);
    await expect(
      service.acceptApplications({
        clientMutationId: 'leave-mutation-2',
        recordIds: ['rec_leave_2'],
        leaveStaffName: '示例人员013',
        startAt: '2026-08-17T09:00:00+08:00',
        endAt: '2026-08-17T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '测试',
      }),
    ).resolves.toEqual({
      accepted: true,
      created: 1,
      recordIds: ['rec_leave_2'],
    });
    expect(store.acceptApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMutationId: 'leave-mutation-2:rec_leave_2',
        recordId: 'rec_leave_2',
      }),
    );
  });

  it('continues routing when an external workflow changes the status before semantic readback', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-concurrent-status-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      休假人员: '梁煊晨',
      休假开始时间: Date.parse('2026-08-21T09:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-21T18:00:00+08:00'),
      机楼: 'D楼',
    };
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_concurrent_status',
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates, { 请假工作流状态: '已审批' });
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([
        {
          ...routePerson('梁煊晨', 'ou_applicant', '运维值班长', ['D楼']),
          supervisorNames: ['陶必亮'],
        },
        routePerson('陶必亮', 'ou_supervisor', '设施运维示例人员001', ['D楼']),
        routePerson('机房经理', 'ou_manager', '设施运维经理', ['H楼']),
      ]),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_leave_concurrent'),
    };
    const bitableSync = {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(
          directoryOf([
            person('梁煊晨', 'ou_applicant', '运维值班长', ['D'], ['陶必亮']),
            person('陶必亮', 'ou_supervisor', '设施运维示例人员001', ['D']),
            person('机房经理', 'ou_manager', '设施运维经理', ['H']),
          ]),
        ),
      getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'd-white-concurrent',
          scheduleDate: '2026-08-21',
          buildingText: 'D楼',
          teamText: 'A班',
          shiftText: '白班',
          dutyStaffActual: ['梁煊晨'],
        },
      ]),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-concurrent-status-1',
        recordIds: ['rec_leave_concurrent_status'],
        leaveStaffName: '梁煊晨',
        startAt: '2026-08-21T09:00:00+08:00',
        endAt: '2026-08-21T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '休年假',
      });

      const runResult = await service.runPendingTasks();
      expect({
        runResult,
        application: await store.getApplication('rec_leave_concurrent_status'),
      }).toEqual({
        runResult: { processed: 2, failed: 0 },
        application: expect.objectContaining({ lastError: '' }),
      });
      expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
        'ou_supervisor',
        expect.any(Object),
        expect.stringContaining('rec_leave_concurrent_status'),
      );
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('delivers approval cards while shift-detail synchronization retries after HTTP 400', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-detail-sync-retry-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      休假人员: '张宇航',
      休假开始时间: Date.parse('2026-08-27T09:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-27T18:00:00+08:00'),
      机楼: 'H楼',
    };
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_detail_sync_retry',
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([
        {
          ...routePerson('张宇航', 'ou_applicant', '运维值班员', ['H楼']),
          supervisorNames: ['周庆庆'],
        },
        routePerson('周庆庆', 'ou_supervisor', 'H楼值班示例人员001', ['H楼']),
        routePerson('机房经理', 'ou_manager', '设施运维经理', ['H楼']),
      ]),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_leave_detail_retry'),
    };
    const bitableSync = {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(
          directoryOf([
            person('张宇航', 'ou_applicant', '运维值班员', ['H'], ['周庆庆']),
            person('周庆庆', 'ou_supervisor', 'H楼值班示例人员001', ['H']),
            person('机房经理', 'ou_manager', '设施运维经理', ['H']),
          ]),
        ),
      getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'schedule_h_white',
          scheduleDate: '2026-08-27',
          buildingText: 'H楼',
          teamText: 'A班',
          shiftText: '白班',
          dutyStaffActual: ['张宇航'],
        },
        {
          recordId: 'schedule_h_white_substitute',
          scheduleDate: '2026-08-27',
          buildingText: 'H楼',
          teamText: 'A班',
          shiftText: '白班',
          dutyStaffActual: ['备班人员'],
        },
      ]),
    };
    const detailGateway = {
      ensurePendingRows: jest
        .fn()
        .mockRejectedValueOnce(new Error('Request failed with status code 400'))
        .mockResolvedValue(undefined),
      upsertCurrentAssignments: jest.fn(),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
      detailGateway as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-detail-sync-retry-1',
        recordIds: ['rec_leave_detail_sync_retry'],
        leaveStaffName: '张宇航',
        startAt: '2026-08-27T09:00:00+08:00',
        endAt: '2026-08-27T18:00:00+08:00',
        leaveType: '调休',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '验证明细同步失败不阻断审批',
      });

      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 2,
        failed: 1,
      });
      await expect(
        store.getApplication('rec_leave_detail_sync_retry'),
      ).resolves.toMatchObject({
        status: 'supervisor_pending',
        lastError: '',
      });
      expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
        'ou_supervisor',
        expect.any(Object),
        expect.stringContaining('rec_leave_detail_sync_retry'),
      );
      expect(gateway.updateLeaveRecord).not.toHaveBeenCalledWith(
        'rec_leave_detail_sync_retry',
        expect.objectContaining({
          请假工作流错误: 'Request failed with status code 400',
        }),
      );
      expect(await store.listTasks()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'sync_leave_shift_details',
            status: 'pending',
            lastError: 'Request failed with status code 400',
          }),
          expect.objectContaining({
            kind: 'deliver_stage_cards',
            status: 'completed',
          }),
        ]),
      );
      await expect(
        service.runPendingTasks(Date.now() + 5_000),
      ).resolves.toEqual({ processed: 1, failed: 0 });
      await expect(
        service.runPendingTasks(Date.now() + 10_000),
      ).resolves.toEqual({ processed: 0, failed: 0 });
      expect(detailGateway.ensurePendingRows).toHaveBeenCalledTimes(2);
      expect(
        (await store.listTasks()).find(
          (task) => task.kind === 'sync_leave_shift_details',
        ),
      ).toMatchObject({ status: 'completed', lastError: '' });
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('writes a card delivery failure back to the leave record for retry visibility', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-delivery-error-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      休假人员: '示例人员008',
      休假开始时间: Date.parse('2026-08-21T09:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-21T18:00:00+08:00'),
      机楼: 'A楼',
    };
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_delivery_error',
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([
        routePerson('示例人员008', 'ou_applicant', 'FOC', ['A楼']),
        {
          ...routePerson('A楼值班账号', 'ou_duty', '值班账号', ['A楼']),
          supervisorNames: ['示例人员009'],
        },
        routePerson('示例人员009', 'ou_supervisor', '运维示例人员001', ['A楼']),
        routePerson('机房经理', 'ou_manager', '设施运维经理', ['H楼']),
      ]),
      sendInteractiveCard: jest
        .fn()
        .mockRejectedValue(new Error('Feishu card delivery unavailable')),
    };
    const bitableSync = {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(
          directoryOf([
            person('示例人员008', 'ou_applicant', 'FOC', ['A'], ['示例人员009']),
            person('示例人员009', 'ou_supervisor', '运维示例人员001', ['A']),
            person('机房经理', 'ou_manager', '设施运维经理', ['H']),
          ]),
        ),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-delivery-error-1',
        recordIds: ['rec_leave_delivery_error'],
        leaveStaffName: '示例人员008',
        startAt: '2026-08-21T09:00:00+08:00',
        endAt: '2026-08-21T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '验证错误可见性',
      });

      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 1,
        failed: 1,
      });
      expect(gateway.updateLeaveRecord).toHaveBeenCalledWith(
        'rec_leave_delivery_error',
        expect.objectContaining({
          请假工作流错误: 'Feishu card delivery unavailable',
        }),
      );
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it.each(['FOC', '电气工程师'])(
    'routes, approves, writes terminal fields, and fan-outs result cards for %s from the durable queue',
    async (position) => {
      const directoryPath = await mkdtemp(
        join(tmpdir(), 'leave-workflow-service-'),
      );
      const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
      const fields: Record<string, unknown> = {
        休假人员: '示例人员008',
        休假开始时间: Date.parse('2026-08-17T09:00:00+08:00'),
        休假结束时间: Date.parse('2026-08-17T18:00:00+08:00'),
        机楼: 'A楼',
        流程截图: [
          { file_token: 'boxcn_leave_result_screenshot', name: '流程截图.png' },
        ],
      };
      let messageIndex = 0;
      const gateway = {
        readLeaveRecord: jest.fn().mockImplementation(async () => ({
          recordId: 'rec_leave_1',
          fields: { ...fields },
        })),
        updateLeaveRecord: jest
          .fn()
          .mockImplementation(async (_recordId, updates) => {
            Object.assign(fields, updates);
          }),
        fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([
          routePerson('示例人员008', 'ou_applicant', position, ['A楼']),
          {
            ...routePerson('A楼值班账号', 'ou_duty', '值班账号', ['A楼']),
            supervisorNames: ['示例人员009'],
          },
          routePerson('示例人员009', 'ou_supervisor', '运维示例人员001', ['A楼']),
          routePerson('机房经理', 'ou_manager', '设施运维经理', ['A楼']),
        ]),
        sendInteractiveCard: jest.fn().mockImplementation(async () => {
          messageIndex += 1;
          return `om_leave_${messageIndex}`;
        }),
        patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
        prepareLeaveApprovalScreenshotImages: jest
          .fn()
          .mockResolvedValue(['img_v3_leave_result_evidence_1']),
      };
      const bitableSync = {
        syncApprovedLeaveScheduleSnapshot: jest.fn().mockResolvedValue({
          nonDutyRecords: 1,
          scheduleRecords: 1,
        }),
        getCachedActivePersonnelDirectory: jest
          .fn()
          .mockResolvedValue(
            directoryOf([
              person('示例人员008', 'ou_applicant', position, ['A'], ['示例人员009']),
              person('示例人员009', 'ou_supervisor', '运维示例人员001', ['A']),
              person('机房经理', 'ou_manager', '设施运维经理', ['A']),
              person('示例人员006', 'ou_professional', '电气示例人员001', ['H']),
            ]),
          ),
      };
      const service = new LeaveWorkflowService(
        store,
        gateway as never,
        bitableSync as never,
      );

      try {
        await service.acceptApplications({
          clientMutationId: 'leave-route-mutation-1',
          recordIds: ['rec_leave_1'],
          leaveStaffName: '示例人员008',
          startAt: '2026-08-17T09:00:00+08:00',
          endAt: '2026-08-17T18:00:00+08:00',
          leaveType: '年假',
          leaveHours: 8,
          approvalDayCount: 1,
          reason: '测试审批闭环',
        });
        await expect(service.runPendingTasks()).resolves.toEqual({
          processed: 2,
          failed: 0,
        });

        expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
        expect(fields).toMatchObject({
          审批来源: '程序卡片',
          请假工作流状态: '待示例人员001审批',
        });

        const accepted = await service.acceptApprovalAction({
          eventId: 'evt_leave_1',
          recordId: 'rec_leave_1',
          stageKey: 'supervisor',
          stageVersion: 1,
          actorOpenId: 'ou_supervisor',
          actorName: '示例人员009',
          action: 'approve',
          messageId: 'om_leave_1',
        });
        expect(accepted.claimed).toBe(true);
        await expect(service.runPendingTasks()).resolves.toEqual({
          processed: 4,
          failed: 0,
        });
        expect(
          bitableSync.syncApprovedLeaveScheduleSnapshot,
        ).toHaveBeenCalledWith([], {
          applicantName: '示例人员008',
          startAt: '2026-08-17T01:00:00.000Z',
          endAt: '2026-08-17T10:00:00.000Z',
        });

        expect(fields).toMatchObject({
          审批来源: '程序卡片',
          请假工作流状态: '已审批',
        });
        expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1])).toContain('同步中');
        expect(gateway.patchInteractiveCard.mock.calls[1][1]).toMatchObject({
          header: { title: { content: '请休假申请已通过' } },
        });
        expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(
          position === 'FOC' ? 3 : 4,
        );
        const professionalNotices =
          gateway.sendInteractiveCard.mock.calls.filter(
            (call) => call[0] === 'ou_professional',
          );
        expect(professionalNotices).toHaveLength(position === 'FOC' ? 0 : 1);
        if (professionalNotices.length) {
          expect(JSON.stringify(professionalNotices[0][1])).not.toContain(
            'callback',
          );
        }
        for (const call of gateway.sendInteractiveCard.mock.calls.slice(1)) {
          expect(JSON.stringify(call[1])).toContain(
            'img_v3_leave_result_evidence_1',
          );
        }
        await expect(
          store.getApplication('rec_leave_1'),
        ).resolves.toMatchObject({
          status: 'approved',
        });
      } finally {
        await rm(directoryPath, { recursive: true, force: true });
      }
    },
  );

  it('prepares leave screenshot evidence once during routing and degrades without blocking approval delivery', async () => {
    const runCase = async (imageFailure: boolean) => {
      const directoryPath = await mkdtemp(
        join(
          tmpdir(),
          `leave-workflow-screenshot-${imageFailure ? 'error' : 'ready'}-`,
        ),
      );
      const recordId = imageFailure
        ? 'rec_leave_screenshot_error'
        : 'rec_leave_screenshot_ready';
      const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
      const fields: Record<string, unknown> = {
        休假人员: '示例人员008',
        休假开始时间: Date.parse('2026-08-17T09:00:00+08:00'),
        休假结束时间: Date.parse('2026-08-17T18:00:00+08:00'),
        机楼: 'A楼',
        流程截图: [
          { file_token: 'boxcn_leave_screenshot', name: '流程截图.png' },
        ],
      };
      const prepareLeaveApprovalScreenshotImages = imageFailure
        ? jest.fn().mockRejectedValue(new Error('image service unavailable'))
        : jest.fn().mockResolvedValue(['img_v3_leave_evidence_1']);
      const gateway = {
        readLeaveRecord: jest.fn().mockResolvedValue({ recordId, fields }),
        updateLeaveRecord: jest
          .fn()
          .mockImplementation(async (_recordId, updates) => {
            Object.assign(fields, updates);
          }),
        fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([
          {
            ...routePerson('示例人员008', 'ou_applicant', 'FOC', ['A楼']),
            supervisorNames: ['示例人员009'],
          },
          routePerson('示例人员009', 'ou_supervisor', '运维示例人员001', ['A楼']),
          routePerson('机房经理', 'ou_manager', '设施运维经理', ['A楼']),
        ]),
        prepareLeaveApprovalScreenshotImages,
        sendInteractiveCard: jest.fn().mockResolvedValue('om_leave_screenshot'),
      };
      const bitableSync = {
        getCachedActivePersonnelDirectory: jest
          .fn()
          .mockResolvedValue(
            directoryOf([
              person('示例人员008', 'ou_applicant', 'FOC', ['A'], ['示例人员009']),
              person('示例人员009', 'ou_supervisor', '运维示例人员001', ['A']),
              person('机房经理', 'ou_manager', '设施运维经理', ['A']),
            ]),
          ),
      };
      const service = new LeaveWorkflowService(
        store,
        gateway as never,
        bitableSync as never,
      );

      try {
        await service.acceptApplications({
          clientMutationId: `leave-screenshot-${imageFailure ? 'error' : 'ready'}`,
          recordIds: [recordId],
          leaveStaffName: '示例人员008',
          startAt: '2026-08-17T09:00:00+08:00',
          endAt: '2026-08-17T18:00:00+08:00',
          leaveType: '年假',
          leaveHours: 8,
          approvalDayCount: 1,
          reason: '截图审批测试',
        });

        await expect(service.runPendingTasks()).resolves.toEqual({
          processed: 2,
          failed: 0,
        });
        expect(prepareLeaveApprovalScreenshotImages).toHaveBeenCalledTimes(1);
        const application = await store.getApplication(recordId);
        const serializedCard = JSON.stringify(
          gateway.sendInteractiveCard.mock.calls[0][1],
        );
        if (imageFailure) {
          expect(application.snapshot).toMatchObject({
            screenshotImageKeys: [],
            screenshotStatus: 'unavailable',
          });
          expect(serializedCard).toContain('截图暂不可预览');
        } else {
          expect(application.snapshot).toMatchObject({
            screenshotImageKeys: ['img_v3_leave_evidence_1'],
            screenshotStatus: 'ready',
          });
          expect(serializedCard).toContain('img_v3_leave_evidence_1');
        }
      } finally {
        await rm(directoryPath, { recursive: true, force: true });
      }
    };

    await runCase(false);
    await runCase(true);
  });

  it('writes a required rejection reason to Base and notifies the applicant with the same reason', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-rejection-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      休假人员: '示例人员008',
      休假开始时间: Date.parse('2026-08-17T09:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-17T18:00:00+08:00'),
      机楼: 'A楼',
    };
    let messageIndex = 0;
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_rejected',
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest.fn().mockImplementation(async () => {
        messageIndex += 1;
        return `om_leave_rejected_${messageIndex}`;
      }),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const bitableSync = {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(
          directoryOf([
            person('示例人员008', 'ou_applicant', 'FOC', ['A'], ['示例人员009']),
            person('示例人员009', 'ou_supervisor', '运维示例人员001', ['A']),
            person('机房经理', 'ou_manager', '设施运维经理', ['H']),
          ]),
        ),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-rejection-1',
        recordIds: ['rec_leave_rejected'],
        leaveStaffName: '示例人员008',
        startAt: '2026-08-17T09:00:00+08:00',
        endAt: '2026-08-17T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '测试驳回闭环',
      });
      await service.runPendingTasks();

      const accepted = await service.acceptApprovalAction({
        eventId: 'evt_leave_reject_1',
        recordId: 'rec_leave_rejected',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor',
        actorName: '示例人员009',
        action: 'reject',
        messageId: 'om_leave_rejected_1',
        rejectionReason: '当日保障力量不足',
      });
      expect(JSON.stringify(accepted.card)).toContain('当日保障力量不足');
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 3,
        failed: 0,
      });

      expect(fields).toMatchObject({
        请假工作流状态: '已驳回',
        请假驳回原因: '当日保障力量不足',
      });
      expect(
        gateway.patchInteractiveCard.mock.calls.some((call) =>
          JSON.stringify(call[1]).includes('当日保障力量不足'),
        ),
      ).toBe(true);
      expect(
        gateway.sendInteractiveCard.mock.calls.some(
          (call) =>
            call[0] === 'ou_applicant' &&
            JSON.stringify(call[1]).includes('当日保障力量不足'),
        ),
      ).toBe(true);
      await expect(
        store.getApplication('rec_leave_rejected'),
      ).resolves.toMatchObject({
        status: 'rejected',
        rejectionReason: '当日保障力量不足',
      });
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('routes an H-building FOC applicant by the active-personnel supervisor field', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-supervisor-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      休假人员: '刘小杏',
      休假开始时间: Date.parse('2026-08-19T09:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-19T18:00:00+08:00'),
      机楼: 'H楼',
    };
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_foc',
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([
        {
          ...routePerson('刘小杏', 'ou_foc', 'FOC', ['H楼']),
          supervisorNames: ['刘小杏', '林柳'],
        },
        routePerson('林柳', 'ou_foc_peer', 'FOC', ['H楼']),
        routePerson('示例人员014', 'ou_deputy_manager', '设施运维副经理', ['H楼']),
        routePerson('示例人员020', 'ou_manager', '设施运维经理', ['H楼']),
      ]),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_leave_foc'),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const bitableSync = {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(
          directoryOf([
            person('刘小杏', 'ou_foc', 'FOC', ['H'], ['示例人员014', '示例人员020']),
            person('林柳', 'ou_foc_peer', 'FOC', ['H']),
            person('示例人员014', 'ou_deputy_manager', '设施运维副经理', ['H']),
            person('示例人员020', 'ou_manager', '设施运维经理', ['H']),
          ]),
        ),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-route-foc-1',
        recordIds: ['rec_leave_foc'],
        leaveStaffName: '刘小杏',
        startAt: '2026-08-19T09:00:00+08:00',
        endAt: '2026-08-19T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '验证人员表示例人员001路由',
      });
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 2,
        failed: 0,
      });

      expect(
        gateway.sendInteractiveCard.mock.calls.map((call) => call[0]).sort(),
      ).toEqual(['ou_deputy_manager', 'ou_manager']);
      expect(fields).toMatchObject({
        审批来源: '程序卡片',
        请假工作流状态: '待示例人员001审批',
      });
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('routes a 110 applicant without a Feishu account and forwards progress and result to the shared duty account', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-110-no-account-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      '休假人员姓名（程序）': '示例人员005',
      休假开始时间: Date.parse('2026-08-20T08:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-20T20:00:00+08:00'),
      机楼: '110站',
    };
    let messageIndex = 0;
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_110_no_account',
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest.fn().mockImplementation(async () => {
        messageIndex += 1;
        return `om_leave_110_${messageIndex}`;
      }),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const applicant = {
      recordId: 'rec_person_bian',
      name: '示例人员005',
      openId: '',
      employeeNo: null,
      position: '110值班人员',
      systemPosition: '110值班人员',
      buildings: ['110'],
      supervisorNames: ['赵六'],
    };
    const sharedDutyAccount = person(
      '南通基地-110kV变电站值班',
      'ou_110_shared',
      '值班账号',
      ['110'],
    );
    const approver = person('赵六', 'ou_electrical_lead', '电气示例人员001', ['110']);
    const substitute = {
      ...person('蒋京桦', 'ou_110_substitute', '值班员（备岗）', ['110']),
      recordId: 'rec_person_substitute_110',
    };
    const manager = person('示例人员020', 'ou_manager', '设施运维经理', ['H']);
    const directory = directoryOf([
      sharedDutyAccount,
      approver,
      substitute,
      manager,
    ]);
    directory.selectablePersonnel = [
      applicant,
      sharedDutyAccount,
      approver,
      substitute,
      manager,
    ];
    const bitableSync = {
      getCachedActivePersonnelDirectory: jest.fn().mockResolvedValue(directory),
      syncApprovedLeaveScheduleSnapshot: jest.fn().mockResolvedValue({
        nonDutyRecords: 1,
        scheduleRecords: 1,
      }),
      getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'schedule-110-white',
          scheduleDate: '2026-08-20',
          buildingText: '110站',
          teamText: 'A班',
          shiftText: '白班',
          dutyStaffActual: ['示例人员005'],
        },
      ]),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-route-110-no-account',
        recordIds: ['rec_leave_110_no_account'],
        leaveStaffName: '示例人员005',
        startAt: '2026-08-20T08:00:00+08:00',
        endAt: '2026-08-20T20:00:00+08:00',
        leaveType: '年假',
        leaveHours: 12,
        approvalDayCount: 1,
        reason: '110 值班人员请假',
      });
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 2,
        failed: 0,
      });

      const firstRecipients = gateway.sendInteractiveCard.mock.calls.map(
        (call) => call[0],
      );
      expect(firstRecipients).toEqual(
        expect.arrayContaining(['ou_electrical_lead', 'ou_110_shared']),
      );
      expect(
        JSON.stringify(gateway.sendInteractiveCard.mock.calls[0][1]),
      ).toContain('rec_person_substitute_110');
      await expect(
        service.acceptApprovalAction({
          eventId: 'evt_leave_110_shared_forged',
          recordId: 'rec_leave_110_no_account',
          stageKey: 'supervisor',
          stageVersion: 1,
          actorOpenId: 'ou_110_shared',
          actorName: '南通基地-110kV变电站值班',
          action: 'approve',
          messageId: 'om_leave_110_2',
          shiftSelections: [
            {
              shiftKey: '2026-08-20T08:00__2026-08-20T20:00',
              substitutePersonRecordId: 'rec_person_substitute_110',
            },
          ],
        }),
      ).resolves.toMatchObject({ claimed: false });

      await expect(
        service.acceptApprovalAction({
          eventId: 'evt_leave_110_missing_substitute',
          recordId: 'rec_leave_110_no_account',
          stageKey: 'supervisor',
          stageVersion: 1,
          actorOpenId: 'ou_electrical_lead',
          actorName: '赵六',
          action: 'approve',
          messageId: 'om_leave_110_1',
        }),
      ).rejects.toThrow('请为每个班次选择替班人员');

      await service.acceptApprovalAction({
        eventId: 'evt_leave_110_approve',
        recordId: 'rec_leave_110_no_account',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_electrical_lead',
        actorName: '赵六',
        action: 'approve',
        messageId: 'om_leave_110_1',
        shiftSelections: [
          {
            shiftKey: '2026-08-20T08:00__2026-08-20T20:00',
            substitutePersonRecordId: 'rec_person_substitute_110',
          },
        ],
      });
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 6,
        failed: 0,
      });
      expect(
        bitableSync.syncApprovedLeaveScheduleSnapshot,
      ).toHaveBeenCalledTimes(1);

      expect(
        gateway.sendInteractiveCard.mock.calls.filter(
          (call) => call[0] === 'ou_110_shared',
        ),
      ).toHaveLength(3);
      expect(
        JSON.stringify(
          gateway.sendInteractiveCard.mock.calls.find(
            (call) =>
              call[0] === 'ou_110_shared' &&
              String(call[2]).includes(':stage-substitute-change:'),
          )?.[1],
        ),
      ).toContain('替班人员已变更');
      expect(
        gateway.sendInteractiveCard.mock.calls.some(
          (call) => call[0] === 'ou_manager',
        ),
      ).toBe(true);
      expect(fields).toMatchObject({
        请假工作流状态: '已审批',
        '是否需要替班（替班打√）': true,
        '替班人员（填姓名）': '蒋京桦',
      });
      await expect(
        store.getApplication('rec_leave_110_no_account'),
      ).resolves.toMatchObject({
        status: 'approved',
        snapshot: {
          applicantName: '示例人员005',
          applicantOpenId: '',
          applicantPersonRecordId: 'rec_person_bian',
          applicantNotificationOpenIds: ['ou_110_shared'],
        },
      });
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('routes a 110 applicant by the authoritative supervisor field on the leave record', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-110-record-supervisor-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      '休假人员姓名（程序）': '示例人员005',
      休假开始时间: Date.parse('2026-08-20T08:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-20T20:00:00+08:00'),
      机楼: '110站',
      示例人员001: '示例人员006',
    };
    const gateway = {
      readLeaveRecord: jest.fn().mockResolvedValue({
        recordId: 'rec_leave_110_record_supervisor',
        fields,
      }),
      updateLeaveRecord: jest.fn().mockImplementation(async (_id, updates) => {
        Object.assign(fields, updates);
      }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_leave_110_direct'),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const applicant = person('示例人员005', '', '110值班人员', ['110']);
    const supervisor = person('示例人员006', 'ou_110_supervisor', '电气示例人员001', [
      '110',
    ]);
    const sharedDutyAccount = person(
      '南通基地-110kV变电站值班',
      'ou_110_shared',
      '值班账号',
      ['110'],
    );
    const substitute = {
      ...person('蒋京桦', 'ou_110_direct_substitute', '值班员（备岗）', [
        '110',
      ]),
      recordId: 'rec_person_direct_substitute_110',
    };
    const manager = person('示例人员020', 'ou_manager', '设施运维经理', ['H']);
    const directory = directoryOf([
      supervisor,
      sharedDutyAccount,
      substitute,
      manager,
    ]);
    directory.selectablePersonnel = [
      applicant,
      supervisor,
      sharedDutyAccount,
      substitute,
      manager,
    ];
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      {
        getCachedActivePersonnelDirectory: jest
          .fn()
          .mockResolvedValue(directory),
        getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
          {
            recordId: 'schedule-110-white-direct',
            scheduleDate: '2026-08-20',
            buildingText: '110站',
            teamText: 'A班',
            shiftText: '白班',
            dutyStaffActual: ['示例人员005'],
          },
        ]),
      } as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-route-110-record-supervisor',
        recordIds: ['rec_leave_110_record_supervisor'],
        leaveStaffName: '示例人员005',
        startAt: '2026-08-20T08:00:00+08:00',
        endAt: '2026-08-20T20:00:00+08:00',
        leaveType: '年假',
        leaveHours: 12,
        approvalDayCount: 1,
        reason: '验证记录示例人员001直路由',
      });
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 2,
        failed: 0,
      });

      expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
        'ou_110_supervisor',
        expect.any(Object),
        expect.any(String),
      );
      expect(
        JSON.stringify(gateway.sendInteractiveCard.mock.calls[0][1]),
      ).toContain('rec_person_direct_substitute_110');
      expect(fields).toMatchObject({
        请假工作流状态: '待示例人员001审批',
        请假当前审批人: [{ id: 'ou_110_supervisor' }],
        请假工作流错误: '',
      });
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('retries a failed 110 station-chief route after the configured supervisor becomes available and sends one card', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-110-chief-retry-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const recordId = 'rec_leave_110_chief_retry';
    const snapshot = stationChiefSnapshot();
    const fields: Record<string, unknown> = {
      '休假人员姓名（程序）': snapshot.applicantName,
      休假开始时间: Date.parse(snapshot.startAt),
      休假结束时间: Date.parse(snapshot.endAt),
      机楼: '110站',
      岗位: '110站站长',
      示例人员001: '示例人员006',
    };
    const stationChief = person('张华', 'ou_station_chief', '110站站长', [
      '110站',
    ]);
    const supervisor = person('示例人员006', 'ou_110_supervisor', '电气示例人员001', [
      'H楼',
    ]);
    const manager = person('示例人员020', 'ou_manager', '设施运维经理', ['H楼']);
    const substitute = person('蒋京桦', 'ou_110_substitute', '值班员（备岗）', [
      '110站',
    ]);
    let personnel = directoryOf([stationChief, manager, substitute]);
    const gateway = {
      readLeaveRecord: jest.fn().mockResolvedValue({ recordId, fields }),
      updateLeaveRecord: jest.fn().mockImplementation(async (_id, updates) => {
        Object.assign(fields, updates);
      }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_110_chief_retry'),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      {
        getCachedActivePersonnelDirectory: jest
          .fn()
          .mockImplementation(async () => personnel),
        getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
          {
            recordId: 'schedule-110-chief-white',
            scheduleDate: '2026-09-29',
            buildingText: '110站',
            teamText: 'A班',
            shiftText: '白班',
            dutyStaffActual: ['张华'],
          },
        ]),
      } as never,
    );

    try {
      await store.acceptApplication({
        clientMutationId: 'mutation-110-chief-retry',
        recordId,
        snapshot,
      });
      await expect(service.runPendingTasks(new Date(), 1)).resolves.toEqual({
        processed: 0,
        failed: 1,
      });
      await expect(store.getApplication(recordId)).resolves.toMatchObject({
        status: 'routing_failed',
      });
      expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();

      personnel = directoryOf([stationChief, supervisor, manager, substitute]);
      await store.wakePendingTasks();
      await expect(service.runPendingTasks(new Date(), 10)).resolves.toEqual({
        processed: 2,
        failed: 0,
      });
      expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
        supervisor.openId,
        expect.any(Object),
        `leave:${recordId}:stage:supervisor:1:${supervisor.openId}`,
      );
      await expect(store.getApplication(recordId)).resolves.toMatchObject({
        status: 'supervisor_pending',
        currentStage: {
          key: 'supervisor',
          approverOpenIds: [supervisor.openId],
        },
      });
      await service.runPendingTasks(new Date(), 10);
      expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('requires a legal substitute on a D-building supervisor card and writes it back atomically', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-substitute-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      休假人员: '示例人员008',
      休假开始时间: Date.parse('2026-08-19T09:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-19T18:00:00+08:00'),
      机楼: 'D楼',
    };
    let messageIndex = 0;
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_d',
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest.fn().mockImplementation(async () => {
        messageIndex += 1;
        return `om_leave_d_${messageIndex}`;
      }),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const bitableSync = {
      syncApprovedLeaveScheduleSnapshot: jest.fn().mockResolvedValue({
        nonDutyRecords: 1,
        scheduleRecords: 1,
      }),
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(
          directoryOf([
            person('示例人员008', 'ou_applicant_d', '运维值班员', ['D'], ['陶必亮']),
            person('陶必亮', 'ou_supervisor_d', '设施运维示例人员001', ['D']),
            person('示例人员007', 'ou_substitute', '实习生（备岗）', ['E']),
            person('示例人员017', 'ou_substitute_new', '长白', ['E']),
            person('相邻夜班', 'ou_blocked', '运维值班员', ['D']),
            person('机房经理', 'ou_manager', '设施运维经理', ['H']),
          ]),
        ),
      getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'd-white',
          scheduleDate: '2026-08-19',
          buildingText: 'D楼',
          teamText: 'A班',
          shiftText: '白班',
          dutyStaffActual: ['示例人员008'],
        },
        {
          recordId: 'd-previous-night',
          scheduleDate: '2026-08-18',
          buildingText: 'D楼',
          teamText: 'B班',
          shiftText: '夜班',
          dutyStaffActual: ['相邻夜班'],
        },
      ]),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-route-d-1',
        recordIds: ['rec_leave_d'],
        leaveStaffName: '示例人员008',
        startAt: '2026-08-19T09:00:00+08:00',
        endAt: '2026-08-19T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '验证示例人员001选择替班',
      });
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 2,
        failed: 0,
      });

      const approvalCard = gateway.sendInteractiveCard.mock.calls[0][1];
      expect(JSON.stringify(approvalCard)).toContain('select_static');
      expect(JSON.stringify(approvalCard)).toContain('person-ou_substitute');
      expect(JSON.stringify(approvalCard)).not.toContain('person-ou_blocked');

      await expect(
        service.acceptApprovalAction({
          eventId: 'evt_leave_d_missing',
          recordId: 'rec_leave_d',
          stageKey: 'supervisor',
          stageVersion: 1,
          actorOpenId: 'ou_supervisor_d',
          actorName: '陶必亮',
          action: 'approve',
          messageId: 'om_leave_d_1',
        }),
      ).rejects.toThrow('请为每个班次选择替班人员');

      await service.acceptApprovalAction({
        eventId: 'evt_leave_d_valid',
        recordId: 'rec_leave_d',
        stageKey: 'supervisor',
        stageVersion: 1,
        actorOpenId: 'ou_supervisor_d',
        actorName: '陶必亮',
        action: 'approve',
        messageId: 'om_leave_d_1',
        shiftSelections: [
          {
            shiftKey: '2026-08-19T09:00__2026-08-19T18:00',
            substitutePersonRecordId: 'person-ou_substitute',
          },
        ],
      });
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 6,
        failed: 0,
      });
      expect(
        bitableSync.syncApprovedLeaveScheduleSnapshot,
      ).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining([
          expect.objectContaining({ scheduleRecordIds: ['d-white'] }),
        ]),
        {
          applicantName: '示例人员008',
          startAt: '2026-08-19T01:00:00.000Z',
          endAt: '2026-08-19T10:00:00.000Z',
        },
      );

      expect(fields).toMatchObject({
        请假工作流状态: '已审批',
        '是否需要替班（替班打√）': true,
        '替班人员（填姓名）': '示例人员007',
      });
      expect(
        gateway.sendInteractiveCard.mock.calls.map((call) => call[0]),
      ).toEqual(expect.arrayContaining(['ou_applicant_d', 'ou_manager']));
      await expect(store.getApplication('rec_leave_d')).resolves.toMatchObject({
        status: 'approved',
        snapshot: {
          shiftAssignments: [
            expect.objectContaining({
              shiftKey: '2026-08-19T09:00__2026-08-19T18:00',
              substituteOpenId: 'ou_substitute',
              substitutePersonRecordId: 'person-ou_substitute',
            }),
          ],
        },
        resultRecipients: expect.arrayContaining([
          expect.objectContaining({ openId: 'ou_substitute' }),
        ]),
      });

      const adjustmentDeliveryIndex =
        gateway.sendInteractiveCard.mock.calls.findIndex((call) =>
          String(call[2]).includes(':substitute-adjustment:0:'),
        );
      expect(adjustmentDeliveryIndex).toBeGreaterThanOrEqual(0);
      const directoryReadsBeforeAdjustment =
        bitableSync.getCachedActivePersonnelDirectory.mock.calls.length;
      await expect(
        service.acceptSubstituteUpdateAction({
          eventId: 'evt_leave_d_substitute_update',
          recordId: 'rec_leave_d',
          expectedRevision: 0,
          actorOpenId: 'ou_supervisor_d',
          actorName: '陶必亮',
          messageId: `om_leave_d_${adjustmentDeliveryIndex + 1}`,
          shiftSelections: [
            {
              shiftKey: '2026-08-19T09:00__2026-08-19T18:00',
              substitutePersonRecordId: 'person-ou_substitute_new',
            },
          ],
        }),
      ).resolves.toMatchObject({ claimed: true });
      expect(
        bitableSync.getCachedActivePersonnelDirectory,
      ).toHaveBeenCalledTimes(directoryReadsBeforeAdjustment);
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 4,
        failed: 0,
      });
      expect(
        bitableSync.syncApprovedLeaveScheduleSnapshot,
      ).toHaveBeenCalledTimes(2);
      expect(fields).toMatchObject({
        '替班人员（填姓名）': '示例人员017',
        替班调整版本: 1,
        替班调整人: [{ id: 'ou_supervisor_d' }],
      });
      await expect(store.getApplication('rec_leave_d')).resolves.toMatchObject({
        snapshot: {
          shiftAssignments: [
            expect.objectContaining({
              shiftKey: '2026-08-19T09:00__2026-08-19T18:00',
              substitutePersonRecordId: 'person-ou_substitute_new',
              substituteName: '示例人员017',
            }),
          ],
          substituteRevision: 1,
        },
      });
      const substituteChangeDeliveries =
        gateway.sendInteractiveCard.mock.calls.filter((call) =>
          String(call[2]).includes(':substitute-update:1:notify:'),
        );
      expect(substituteChangeDeliveries.map((call) => call[0]).sort()).toEqual(
        [
          'ou_applicant_d',
          'ou_manager',
          'ou_substitute',
          'ou_substitute_new',
          'ou_supervisor_d',
        ].sort(),
      );
      expect(
        JSON.stringify(
          substituteChangeDeliveries.find(
            (call) => call[0] === 'ou_substitute',
          )?.[1],
        ),
      ).toContain('您原承担的替班已取消');
      expect(
        JSON.stringify(
          substituteChangeDeliveries.find(
            (call) => call[0] === 'ou_substitute_new',
          )?.[1],
        ),
      ).toContain('您已被安排为新的替班人员');
      expect(
        JSON.stringify(
          substituteChangeDeliveries.find(
            (call) => call[0] === 'ou_manager',
          )?.[1],
        ),
      ).toContain('审批完成后的替班安排已更新');

      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 0,
        failed: 0,
      });
      expect(
        gateway.sendInteractiveCard.mock.calls.filter((call) =>
          String(call[2]).includes(':substitute-update:1:notify:'),
        ),
      ).toHaveLength(5);
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('uses the local E-building identity and requires a substitute during manager-direct approval', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-manager-substitute-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      休假人员: '陈凯',
      休假开始时间: Date.parse('2026-08-18T09:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-18T18:00:00+08:00'),
      机楼: 'optpT0s3iH',
    };
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_manager_direct',
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValue('om_leave_manager_direct_1'),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const bitableSync = {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(
          directoryOf([
            person('陈凯', 'ou_applicant_e', '设施运维示例人员001', ['E']),
            person('示例人员020', 'ou_manager', '设施运维经理', ['H']),
            person('示例人员007', 'ou_substitute', '实习生（备岗）', ['E']),
          ]),
        ),
      getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'e-long-white-applicant',
          scheduleDate: '2026-08-18',
          buildingText: 'E楼',
          teamText: '长白',
          shiftText: '长白',
          dutyStaffActual: ['陈凯'],
        },
        {
          recordId: 'e-long-white-substitute',
          scheduleDate: '2026-08-18',
          buildingText: 'E楼',
          teamText: '长白',
          shiftText: '长白',
          dutyStaffActual: ['示例人员007'],
        },
      ]),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-route-manager-direct-1',
        recordIds: ['rec_leave_manager_direct'],
        leaveStaffName: '陈凯',
        startAt: '2026-08-18T09:00:00+08:00',
        endAt: '2026-08-18T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '验证经理直审替班',
      });
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 2,
        failed: 0,
      });

      const serialized = JSON.stringify(
        gateway.sendInteractiveCard.mock.calls[0][1],
      );
      expect(serialized).toContain('select_static');
      expect(serialized).toContain(
        'leave_substitute_decision_submit:rec_leave_manager_direct:manager:1',
      );
      expect(serialized).toContain('确认审批');
      expect(serialized).not.toContain('leave_approve_submit:');
      expect(serialized).not.toContain('逐班次替班安排');
      expect(serialized).toContain('E楼 · 设施运维示例人员001');
      expect(serialized).toContain('2026-08-18 09:00 至 2026-08-18 18:00');
      expect(serialized).not.toContain('optpT0s3iH');
      expect(serialized).not.toContain('2026-08-18 01:00');

      const requiredCard = await service.renderApprovalCardView({
        recordId: 'rec_leave_manager_direct',
        stageKey: 'manager',
        stageVersion: 1,
        actorOpenId: 'ou_manager',
        view: 'substitute_required',
      });
      expect(JSON.stringify(requiredCard)).toContain(
        'leave_substitute_review_submit:rec_leave_manager_direct:manager:1:g1:r1:d1',
      );
      expect(JSON.stringify(requiredCard)).toContain('逐班次替班安排');

      const noSubstituteCard = await service.renderApprovalCardView({
        recordId: 'rec_leave_manager_direct',
        stageKey: 'manager',
        stageVersion: 1,
        actorOpenId: 'ou_manager',
        view: 'substitute_not_required',
      });
      expect(JSON.stringify(noSubstituteCard)).toContain(
        '"substituteRequired":false',
      );
      expect(JSON.stringify(noSubstituteCard)).toContain('确认审批');
      expect(JSON.stringify(noSubstituteCard)).not.toContain(
        'leave_substitute_requirement',
      );
      expect(JSON.stringify(noSubstituteCard)).not.toContain(
        'leave_approve_submit:',
      );
      expect(JSON.stringify(noSubstituteCard)).not.toContain('逐班次替班安排');

      await expect(
        service.acceptApprovalAction({
          eventId: 'evt_leave_manager_direct_missing',
          recordId: 'rec_leave_manager_direct',
          stageKey: 'manager',
          stageVersion: 1,
          actorOpenId: 'ou_manager',
          actorName: '示例人员020',
          action: 'approve',
          messageId: 'om_leave_manager_direct_1',
        }),
      ).rejects.toThrow('请选择是否需要替班');
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('keeps an all-long-white H-building duty supervisor in the mandatory substitute path', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-h-duty-supervisor-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const fields: Record<string, unknown> = {
      休假人员: '周庆庆',
      休假开始时间: Date.parse('2026-08-28T09:00:00+08:00'),
      休假结束时间: Date.parse('2026-08-28T18:00:00+08:00'),
      机楼: 'H楼',
    };
    const gateway = {
      readLeaveRecord: jest.fn().mockResolvedValue({
        recordId: 'rec_leave_h_duty_supervisor',
        fields,
      }),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValue('om_leave_h_duty_supervisor_1'),
    };
    const bitableSync = {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(
          directoryOf([
            person('周庆庆', 'ou_h_duty_supervisor', 'H楼值班示例人员001', ['H']),
            person('示例人员020', 'ou_manager', '设施运维经理', ['H']),
            person('李董', 'ou_h_substitute', '长白', ['H']),
          ]),
        ),
      getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'h-long-white-applicant',
          scheduleDate: '2026-08-28',
          buildingText: 'H楼',
          teamText: '长白',
          shiftText: '长白',
          dutyStaffActual: ['周庆庆'],
        },
        {
          recordId: 'h-long-white-substitute',
          scheduleDate: '2026-08-28',
          buildingText: 'H楼',
          teamText: '长白',
          shiftText: '长白',
          dutyStaffActual: ['李董'],
        },
      ]),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      bitableSync as never,
    );

    try {
      await service.acceptApplications({
        clientMutationId: 'leave-route-h-duty-supervisor-1',
        recordIds: ['rec_leave_h_duty_supervisor'],
        leaveStaffName: '周庆庆',
        startAt: '2026-08-28T09:00:00+08:00',
        endAt: '2026-08-28T18:00:00+08:00',
        leaveType: '年假',
        leaveHours: 8,
        approvalDayCount: 1,
        reason: '验证H楼值班示例人员001强制替班',
      });
      await expect(service.runPendingTasks()).resolves.toEqual({
        processed: 2,
        failed: 0,
      });

      const application = await store.getApplication(
        'rec_leave_h_duty_supervisor',
      );
      expect(application?.snapshot).toMatchObject({
        substituteRequired: true,
        substituteDecisionRequired: false,
      });
      const serialized = JSON.stringify(
        gateway.sendInteractiveCard.mock.calls[0][1],
      );
      expect(serialized).toContain('逐班次替班安排');
      expect(serialized).not.toContain('leave_substitute_requirement');
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('notifies every role when a manager replaces the supervisor-selected substitute and isolates one failed recipient', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-stage-substitute-change-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const recordId = 'rec_leave_stage_substitute_change';
    const applicant = routePerson('示例人员008', 'ou_stage_applicant', '运维值班员', [
      'D楼',
    ]);
    const supervisor = routePerson(
      '陶必亮',
      'ou_stage_supervisor',
      '设施运维示例人员001',
      ['D楼'],
    );
    const manager = routePerson('示例人员020', 'ou_stage_manager', '设施运维经理', [
      'H楼',
    ]);
    const previousSubstitute = routePerson(
      '示例人员013',
      'ou_stage_previous',
      '长白',
      ['D楼'],
    );
    const substitute = routePerson('示例人员017', 'ou_stage_new', '长白', ['D楼']);
    const snapshot = {
      applicantName: applicant.name,
      applicantOpenId: applicant.openId,
      applicantPersonRecordId: 'person-ou_stage_applicant',
      applicantNotificationOpenIds: [],
      building: 'D楼',
      position: applicant.position,
      leaveType: '年假',
      startAt: '2026-08-24T09:00:00+08:00',
      endAt: '2026-08-24T18:00:00+08:00',
      leaveHours: 8,
      approvalDayCount: 4,
      reason: '验证审批阶段改选替班',
      substituteRequired: true,
      substituteName: previousSubstitute.name,
      substituteOpenId: previousSubstitute.openId,
      substitutePersonRecordId: 'person-ou_stage_previous',
      substituteCandidates: [
        {
          ...previousSubstitute,
          personRecordId: 'person-ou_stage_previous',
        },
        { ...substitute, personRecordId: 'person-ou_stage_new' },
      ],
      substituteRevision: 0,
    };
    const approvalPlan = {
      approvalClass: 'ordinary' as const,
      discipline: null,
      approvalDayCount: 4,
      stages: [
        {
          key: 'supervisor' as const,
          approvers: [supervisor],
          resolutionPolicy: 'first_legal_action' as const,
        },
        {
          key: 'manager' as const,
          approvers: [manager],
          resolutionPolicy: 'first_legal_action' as const,
        },
      ],
      notificationPlan: {
        finalResultRecipients: [applicant, supervisor, manager],
        professionalRecipients: [],
        substituteRecipients: [previousSubstitute],
      },
    };
    const fields: Record<string, unknown> = {
      休假人员: applicant.name,
      休假开始时间: Date.parse(snapshot.startAt),
      休假结束时间: Date.parse(snapshot.endAt),
      机楼: snapshot.building,
    };
    let messageIndex = 0;
    let previousFailureRemaining = true;
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId,
        fields: { ...fields },
      })),
      updateLeaveRecord: jest
        .fn()
        .mockImplementation(async (_recordId, updates) => {
          Object.assign(fields, updates);
        }),
      sendInteractiveCard: jest
        .fn()
        .mockImplementation(
          async (openId: string, _card: unknown, businessKey: string) => {
            if (
              openId === previousSubstitute.openId &&
              businessKey.includes(
                ':stage-substitute-change:manager:2:notify:',
              ) &&
              previousFailureRemaining
            ) {
              previousFailureRemaining = false;
              throw new Error('previous substitute temporarily unavailable');
            }
            messageIndex += 1;
            return `om_stage_substitute_${messageIndex}`;
          },
        ),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const directory = directoryOf([
      person(
        applicant.name,
        applicant.openId,
        applicant.position,
        applicant.buildings,
      ),
      person(
        supervisor.name,
        supervisor.openId,
        supervisor.position,
        supervisor.buildings,
      ),
      person(manager.name, manager.openId, manager.position, manager.buildings),
      person(
        previousSubstitute.name,
        previousSubstitute.openId,
        previousSubstitute.position,
        previousSubstitute.buildings,
      ),
      person(
        substitute.name,
        substitute.openId,
        substitute.position,
        substitute.buildings,
      ),
    ]);
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      {
        getCachedActivePersonnelDirectory: jest
          .fn()
          .mockResolvedValue(directory),
        syncApprovedLeaveScheduleSnapshot: jest.fn().mockResolvedValue({
          nonDutyRecords: 1,
          scheduleRecords: 1,
        }),
      } as never,
    );

    try {
      await store.acceptApplication({
        clientMutationId: 'leave-stage-substitute-change',
        recordId,
        snapshot,
      });
      await store.setApprovalPlan(recordId, {
        snapshot,
        approvalPlan,
        resultRecipients: [applicant, supervisor, manager, previousSubstitute],
      });
      await store.setPendingStage(recordId, {
        key: 'manager',
        version: 2,
        approverOpenIds: [manager.openId],
      });
      await service.acceptApprovalAction({
        eventId: 'evt_stage_substitute_change',
        recordId,
        stageKey: 'manager',
        stageVersion: 2,
        actorOpenId: manager.openId,
        actorName: manager.name,
        action: 'approve',
        messageId: 'om_manager_card',
        substitutePersonRecordId: 'person-ou_stage_new',
      });

      const firstRun = await service.runPendingTasks(new Date(), 20);
      expect(firstRun.failed).toBe(1);
      const firstNotifications = gateway.sendInteractiveCard.mock.calls.filter(
        (call) =>
          String(call[2]).includes(
            ':stage-substitute-change:manager:2:notify:',
          ),
      );
      expect(
        [...new Set(firstNotifications.map((call) => call[0]))].sort(),
      ).toEqual(
        [
          previousSubstitute.openId,
          substitute.openId,
          applicant.openId,
          supervisor.openId,
          manager.openId,
        ].sort(),
      );
      expect(
        JSON.stringify(
          firstNotifications.find(
            (call) => call[0] === previousSubstitute.openId,
          )?.[1],
        ),
      ).toContain('您原承担的替班已取消');
      expect(
        JSON.stringify(
          firstNotifications.find((call) => call[0] === substitute.openId)?.[1],
        ),
      ).toContain('您已被安排为新的替班人员');
      expect(
        firstNotifications.filter((call) => call[0] === manager.openId),
      ).toHaveLength(1);
      expect(
        firstNotifications.filter((call) => call[0] === supervisor.openId),
      ).toHaveLength(1);

      const secondRun = await service.runPendingTasks(
        new Date(Date.now() + 60_000),
        20,
      );
      expect(secondRun.failed).toBe(0);
      const allNotifications = gateway.sendInteractiveCard.mock.calls.filter(
        (call) =>
          String(call[2]).includes(
            ':stage-substitute-change:manager:2:notify:',
          ),
      );
      expect(
        allNotifications.filter(
          (call) => call[0] === previousSubstitute.openId,
        ),
      ).toHaveLength(2);
      expect(
        allNotifications.filter((call) => call[0] === manager.openId),
      ).toHaveLength(1);
      expect(
        allNotifications.filter((call) => call[0] === supervisor.openId),
      ).toHaveLength(1);
      await expect(
        store.getStageAction(recordId, 'manager', 2),
      ).resolves.toEqual(
        expect.objectContaining({
          previousSubstituteOpenId: previousSubstitute.openId,
          previousSubstituteName: previousSubstitute.name,
          substituteOpenId: substitute.openId,
          substituteName: substitute.name,
        }),
      );
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('repairs a misrouted 110 station-chief card before delivering the correct card exactly once', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-station-chief-reroute-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const snapshot = await seedMisroutedStationChief(store);
    const fields: Record<string, unknown> = {
      '休假人员姓名（程序）': snapshot.applicantName,
      休假开始时间: Date.parse(snapshot.startAt),
      休假结束时间: Date.parse(snapshot.endAt),
      机楼: '110站',
      岗位: '110站站长',
      示例人员001: '示例人员006',
    };
    const stationChief = person(
      '张华',
      'ou_station_chief',
      '110站站长',
      ['110站'],
      ['示例人员020'],
    );
    const stationSupervisor = person(
      '示例人员006',
      'ou_station_supervisor',
      '电气示例人员001',
      ['H楼'],
    );
    const manager = person('示例人员020', 'ou_wrong_manager', '设施运维经理', [
      '全园区',
    ]);
    const gateway = {
      readLeaveRecord: jest.fn().mockImplementation(async () => ({
        recordId: 'rec_leave_station_chief',
        fields,
      })),
      updateLeaveRecord: jest.fn().mockImplementation(async (_id, updates) => {
        Object.assign(fields, updates);
      }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValue('om_correct_station_card'),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
      findLeaveRecordsByCodes: jest.fn().mockResolvedValue([]),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      {
        getCachedActivePersonnelDirectory: jest
          .fn()
          .mockResolvedValue(
            directoryOf([stationChief, stationSupervisor, manager]),
          ),
      } as never,
    );

    try {
      await expect(
        service.recoverMisroutedStationChiefApplications(),
      ).resolves.toEqual({ scheduled: 1 });
      await expect(
        store.claimStageAction({
          eventId: 'evt_obsolete_manager_card',
          recordId: 'rec_leave_station_chief',
          stageKey: 'manager',
          stageVersion: 1,
          actorOpenId: 'ou_wrong_manager',
          actorName: '示例人员020',
          action: 'approve',
          messageId: 'om_wrong_manager_card',
        }),
      ).resolves.toMatchObject({ accepted: false, reason: 'stale_stage' });

      await expect(service.runPendingTasks(new Date(), 10)).resolves.toEqual({
        processed: 2,
        failed: 0,
      });
      expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
      expect(gateway.patchInteractiveCard).toHaveBeenCalledWith(
        'om_wrong_manager_card',
        expect.any(Object),
      );
      const terminalCard = JSON.stringify(
        gateway.patchInteractiveCard.mock.calls[0][1],
      );
      expect(terminalCard).toContain('请休假审批已转交');
      expect(terminalCard).toContain('原审批已失效');
      expect(terminalCard).not.toContain('callback');
      expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
        stationSupervisor.openId,
        expect.any(Object),
        'leave:rec_leave_station_chief:stage:supervisor:2:ou_station_supervisor',
      );
      expect(
        gateway.patchInteractiveCard.mock.invocationCallOrder[0],
      ).toBeLessThan(gateway.sendInteractiveCard.mock.invocationCallOrder[0]);
      expect(fields).toMatchObject({
        请假工作流状态: '待示例人员001审批',
        请假当前审批人: [{ id: stationSupervisor.openId }],
        请假工作流错误: '',
      });
      await expect(
        store.getApplication('rec_leave_station_chief'),
      ).resolves.toMatchObject({
        status: 'supervisor_pending',
        currentStage: {
          key: 'supervisor',
          version: 2,
          approverOpenIds: [stationSupervisor.openId],
        },
      });

      await expect(
        service.recoverMisroutedStationChiefApplications(),
      ).resolves.toEqual({ scheduled: 0 });
      await service.runPendingTasks(new Date(Date.now() + 60_000), 10);
      expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
      expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('does not migrate ordinary 110 staff or another building during station-chief recovery', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-station-chief-scope-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    try {
      for (const [recordId, position, building] of [
        ['rec_leave_ordinary_110', '110值班人员', '110站'],
        ['rec_leave_other_building', '110站站长', 'A楼'],
      ] as const) {
        await store.acceptApplication({
          clientMutationId: `mutation-${recordId}`,
          recordId,
          snapshot: stationChiefSnapshot({ position, building }),
        });
        await store.setPendingStage(recordId, {
          key: 'manager',
          version: 1,
          approverOpenIds: ['ou_wrong_manager'],
        });
      }
      const service = new LeaveWorkflowService(store, {} as never, {} as never);

      await expect(
        service.recoverMisroutedStationChiefApplications(),
      ).resolves.toEqual({ scheduled: 0 });
      await expect(
        store.getApplication('rec_leave_ordinary_110'),
      ).resolves.toMatchObject({
        status: 'manager_pending',
        currentStage: { key: 'manager', version: 1 },
      });
      await expect(
        store.getApplication('rec_leave_other_building'),
      ).resolves.toMatchObject({
        status: 'manager_pending',
        currentStage: { key: 'manager', version: 1 },
      });
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('invalidates the obsolete manager card and fails closed when the station supervisor identity is unavailable', async () => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), 'leave-workflow-station-chief-fail-closed-'),
    );
    const store = new LeaveWorkflowStore(join(directoryPath, 'ledger.json'));
    const snapshot = await seedMisroutedStationChief(store);
    const fields: Record<string, unknown> = {
      '休假人员姓名（程序）': snapshot.applicantName,
      休假开始时间: Date.parse(snapshot.startAt),
      休假结束时间: Date.parse(snapshot.endAt),
      机楼: '110站',
      岗位: '110站站长',
      示例人员001: '示例人员006',
    };
    const stationChief = person(
      '张华',
      'ou_station_chief',
      '110站站长',
      ['110站'],
      ['示例人员006'],
    );
    const manager = person('示例人员020', 'ou_wrong_manager', '设施运维经理', [
      '全园区',
    ]);
    const gateway = {
      readLeaveRecord: jest.fn().mockResolvedValue({
        recordId: 'rec_leave_station_chief',
        fields,
      }),
      updateLeaveRecord: jest.fn().mockImplementation(async (_id, updates) => {
        Object.assign(fields, updates);
      }),
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue([]),
      sendInteractiveCard: jest.fn(),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LeaveWorkflowService(
      store,
      gateway as never,
      {
        getCachedActivePersonnelDirectory: jest
          .fn()
          .mockResolvedValue(directoryOf([stationChief, manager])),
      } as never,
    );

    try {
      await service.recoverMisroutedStationChiefApplications();
      await expect(service.runPendingTasks(new Date(), 10)).resolves.toEqual({
        processed: 0,
        failed: 1,
      });
      expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify(gateway.patchInteractiveCard.mock.calls[0][1]),
      ).toContain('请休假审批路由异常');
      expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
      await expect(
        store.getApplication('rec_leave_station_chief'),
      ).resolves.toMatchObject({
        status: 'routing_failed',
        currentStage: null,
        lastError: expect.stringContaining('示例人员006'),
      });
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });
});

function person(
  name: string,
  openId: string,
  position: string,
  buildings: string[],
  supervisorNames: string[] = [],
) {
  return {
    recordId: `person-${openId}`,
    name,
    openId,
    employeeNo: null,
    position,
    systemPosition: position,
    buildings,
    supervisorNames,
  };
}

function routePerson(
  name: string,
  openId: string,
  position: string,
  buildings: string[],
) {
  return { name, openId, position, buildings };
}

function directoryOf(personnel: ReturnType<typeof person>[]) {
  return {
    personnel,
    managers: personnel.filter((item) => item.position.includes('经理')),
    snapshot: {
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      stale: false,
    },
    quality: {
      sourceRecordCount: personnel.length,
      activeRecordCount: personnel.length,
      inactiveRecordCount: 0,
      usablePersonnelCount: personnel.length,
      managerCount: 1,
      missingNameCount: 0,
      missingOpenIdCount: 0,
      duplicateOpenIdCount: 0,
      missingBuildingCount: 0,
    },
  };
}

function stationChiefSnapshot(
  overrides: Partial<ReturnType<typeof stationChiefSnapshotBase>> = {},
) {
  return { ...stationChiefSnapshotBase(), ...overrides };
}

function stationChiefSnapshotBase() {
  return {
    applicantName: '张华',
    applicantOpenId: 'ou_station_chief',
    applicantPersonRecordId: 'person-ou_station_chief',
    applicantNotificationOpenIds: [],
    building: '110站',
    position: '110站站长',
    leaveType: '年假',
    startAt: '2026-09-29T08:00:00+08:00',
    endAt: '2026-09-29T20:00:00+08:00',
    leaveHours: 12,
    approvalDayCount: 1,
    reason: '请休假',
  };
}

async function seedMisroutedStationChief(store: LeaveWorkflowStore) {
  const snapshot = stationChiefSnapshot();
  await store.acceptApplication({
    clientMutationId: 'mutation-station-chief',
    recordId: 'rec_leave_station_chief',
    snapshot,
  });
  const routeTask = await store.takeNextTask();
  if (!routeTask) throw new Error('expected initial route task');
  await store.completeTask(routeTask.key, routeTask.claimToken);
  const wrongManager = routePerson(
    '示例人员020',
    'ou_wrong_manager',
    '设施运维经理',
    ['全园区'],
  );
  await store.setApprovalPlan('rec_leave_station_chief', {
    snapshot,
    approvalPlan: {
      approvalClass: 'manager_direct',
      discipline: null,
      approvalDayCount: 1,
      stages: [
        {
          key: 'manager',
          approvers: [wrongManager],
          resolutionPolicy: 'first_legal_action',
        },
      ],
      notificationPlan: {
        finalResultRecipients: [wrongManager],
        professionalRecipients: [],
        substituteRecipients: [],
      },
    },
    resultRecipients: [wrongManager],
  });
  await store.setPendingStage('rec_leave_station_chief', {
    key: 'manager',
    version: 1,
    approverOpenIds: [wrongManager.openId],
  });
  await store.recordStageCardDelivery('rec_leave_station_chief', {
    recipientOpenId: wrongManager.openId,
    messageId: 'om_wrong_manager_card',
    businessKey:
      'leave:rec_leave_station_chief:stage:manager:1:ou_wrong_manager',
  });
  const deliveryTask = await store.takeNextTask();
  if (!deliveryTask) throw new Error('expected obsolete delivery task');
  await store.completeTask(deliveryTask.key, deliveryTask.claimToken);
  return snapshot;
}
