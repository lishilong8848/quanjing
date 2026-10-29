import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttendanceAutomationCoordinatorService,
  deriveAttendanceResults,
  type AttendanceAutomationRunStatus,
} from '../../server/modules/duty-schedule/attendance-automation-coordinator.service';

describe('AttendanceAutomationCoordinatorService', () => {
  let stateDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'attendance-automation-test-'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_STATE_DIR: stateDir,
      PUBLIC_BASE_URL: 'https://ops.example.com',
      CLIENT_BASE_PATH: '/platform',
      FEISHU_ATTENDANCE_SCHEDULE_URL:
        'https://example.test/legacy-feishu-bitable',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(stateDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it.each([
    {
      task: 'morning-off-duty-check' as const,
      scheduledAt: '2026-09-11T01:30:00.000Z',
      attemptCount: 6,
      maxAttempts: 6,
      staleVersion: 'v5-scoped-reconciliation-recovery',
    },
    {
      task: 'evening-off-duty-check' as const,
      scheduledAt: '2026-09-11T10:35:00.000Z',
      attemptCount: 1,
      maxAttempts: 1,
      staleVersion: 'v4-scoped-archive-reconciliation',
    },
  ])(
    'does not reuse the exhausted prior $task state after deployment recovery is upgraded',
    ({ task, scheduledAt, attemptCount, maxAttempts, staleVersion }) => {
      writeFileSync(
        join(stateDir, 'attendance-automation-task-state.json'),
        `${JSON.stringify({
          version: 1,
          completed: {},
          runs: {
            [`2026-09-11:${task}:${staleVersion}`]: {
              state: 'failed',
              task,
              date: '2026-09-11',
              scheduledAt,
              firstAttemptAt: scheduledAt,
              lastAttemptAt: scheduledAt,
              attemptCount,
              maxAttempts,
              finalFailure: true,
            },
          },
        })}\n`,
        'utf8',
      );
      const service = new AttendanceAutomationCoordinatorService(
        {} as never,
        {} as never,
        {} as never,
      );

      expect(service.getRunStatus(task, '2026-09-11')).toBeNull();
    },
  );

  it('keeps the current v5 evening final-check state readable while only morning advances to v6', () => {
    writeFileSync(
      join(stateDir, 'attendance-automation-task-state.json'),
      `${JSON.stringify({
        version: 1,
        completed: {},
        runs: {
          '2026-09-11:evening-off-duty-check:v5-scoped-reconciliation-recovery':
            {
              state: 'completed',
              task: 'evening-off-duty-check',
              date: '2026-09-11',
              scheduledAt: '2026-09-11T10:35:00.000Z',
              lastAttemptAt: '2026-09-11T10:35:01.000Z',
              completedAt: '2026-09-11T10:35:01.000Z',
            },
        },
      })}\n`,
      'utf8',
    );
    const service = new AttendanceAutomationCoordinatorService(
      {} as never,
      {} as never,
      {} as never,
    );

    expect(
      service.getRunStatus('evening-off-duty-check', '2026-09-11'),
    ).toMatchObject({ state: 'completed' });
  });

  it('does not reuse the completed v3 archive state after late-punch recovery is upgraded', () => {
    writeFileSync(
      join(stateDir, 'attendance-automation-task-state.json'),
      `${JSON.stringify({
        version: 1,
        completed: {
          '2026-09-15:archive-yesterday:v3-correction-discovery': {
            completedAt: '2026-09-15T16:31:00.000Z',
          },
        },
        runs: {},
      })}\n`,
      'utf8',
    );
    const service = new AttendanceAutomationCoordinatorService(
      {} as never,
      {} as never,
      {} as never,
    );

    expect(service.getRunStatus('archive-yesterday', '2026-09-15')).toBeNull();
  });

  it('reopens an exhausted final check as one persisted manual retry and completes the task', async () => {
    const taskKey =
      '2026-09-12:morning-off-duty-check:v6-group-card-resilience';
    writeFileSync(
      join(stateDir, 'attendance-automation-task-state.json'),
      `${JSON.stringify({
        version: 1,
        completed: {},
        runs: {
          [taskKey]: {
            state: 'failed',
            task: 'morning-off-duty-check',
            date: '2026-09-12',
            scheduledAt: '2026-09-12T01:30:00.000Z',
            firstAttemptAt: '2026-09-12T01:30:00.000Z',
            lastAttemptAt: '2026-09-12T01:58:00.000Z',
            attemptCount: 6,
            maxAttempts: 6,
            failedAt: '2026-09-12T01:58:00.000Z',
            failureReason: '飞书考勤多维表同步失败',
            finalFailure: true,
          },
        },
      })}\n`,
      'utf8',
    );
    let finishExecution!: (value: unknown) => void;
    const pendingExecution = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const service = new AttendanceAutomationCoordinatorService(
      {} as never,
      {} as never,
      {} as never,
    );
    const execute = jest
      .spyOn(service as never, 'execute')
      .mockReturnValue(pendingExecution as never);
    const writeState = jest.spyOn(service as never, 'writeState');
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-12',
      scheduledAt: new Date('2026-09-12T01:30:00.000Z'),
    };

    expect(
      service.requestManualRetry(run, 'attendance-manual-20260912-001'),
    ).toEqual({
      success: true,
      accepted: true,
      duplicate: false,
      inProgress: true,
      clientMutationId: 'attendance-manual-20260912-001',
      task: 'morning-off-duty-check',
      date: '2026-09-12',
      state: 'running',
    });
    expect(service.getRunStatus(run.task, run.date)).toMatchObject({
      state: 'running',
      attemptCount: 1,
      maxAttempts: 1,
    });
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        readFileSync(
          join(stateDir, 'attendance-automation-task-state.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      manualRetries: {
        'attendance-manual-20260912-001': {
          taskKey,
          task: 'morning-off-duty-check',
          date: '2026-09-12',
        },
      },
    });

    finishExecution({ success: true });
    await new Promise((resolve) => setImmediate(resolve));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      ...run,
      deferAttendanceArchive: true,
    });
    expect(service.getRunStatus(run.task, run.date)).toMatchObject({
      state: 'completed',
      attemptCount: 1,
      completedAt: expect.any(String),
    });
  });

  it('reports a newly queued Feishu archive as syncing instead of failed', () => {
    const taskKey =
      '2026-09-20:morning-off-duty-check:v6-group-card-resilience';
    writeFileSync(
      join(stateDir, 'attendance-automation-task-state.json'),
      `${JSON.stringify({
        version: 1,
        completed: {},
        runs: {
          [taskKey]: {
            state: 'completed',
            task: 'morning-off-duty-check',
            date: '2026-09-20',
            scheduledAt: '2026-09-20T01:30:00.000Z',
            lastAttemptAt: '2026-09-20T01:30:00.000Z',
            completedAt: '2026-09-20T01:30:01.000Z',
          },
        },
      })}\n`,
      'utf8',
    );
    const jobs = join(stateDir, 'attendance-archive-jobs');
    mkdirSync(jobs, { recursive: true });
    writeFileSync(
      join(jobs, '2026-09-20-morning-off-duty-check.json'),
      `${JSON.stringify({
        version: 1,
        task: 'morning-off-duty-check',
        date: '2026-09-20',
        scheduledAt: '2026-09-20T01:30:00.000Z',
        stage: 'pending',
        attemptCount: 0,
        input: {
          businessDate: '2026-09-20',
          users: [],
          results: [],
          details: [],
        },
        nextRetryAt: '2026-09-20T01:30:01.000Z',
      })}\n`,
      'utf8',
    );
    const service = new AttendanceAutomationCoordinatorService(
      {} as never,
      {} as never,
      {} as never,
    );

    const status = service.getRunStatus(
      'morning-off-duty-check',
      '2026-09-20',
    ) as AttendanceAutomationRunStatus & { archiveSyncState?: string };

    expect(status.archiveSyncState).toBe('syncing');
    expect(status.archiveSyncFailureReason).toBeUndefined();
  });

  it('deduplicates the same manual mutation and rejects a second concurrent run', async () => {
    let finishExecution!: (value: unknown) => void;
    const pendingExecution = new Promise((resolve) => {
      finishExecution = resolve;
    });
    const service = new AttendanceAutomationCoordinatorService(
      {} as never,
      {} as never,
      {} as never,
    );
    const execute = jest
      .spyOn(service as never, 'execute')
      .mockReturnValue(pendingExecution as never);
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-12',
      scheduledAt: new Date('2026-09-12T01:30:00.000Z'),
    };

    service.requestManualRetry(run, 'attendance-manual-20260912-002');
    expect(
      service.requestManualRetry(run, 'attendance-manual-20260912-002'),
    ).toMatchObject({
      accepted: false,
      duplicate: true,
      inProgress: true,
      state: 'running',
    });
    expect(
      service.requestManualRetry(run, 'attendance-manual-20260912-003'),
    ).toMatchObject({
      accepted: false,
      duplicate: false,
      inProgress: true,
      state: 'running',
    });
    expect(execute).toHaveBeenCalledTimes(1);

    finishExecution({ success: true });
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('records one manual failure as a terminal 1/1 run without another automatic retry', async () => {
    const service = new AttendanceAutomationCoordinatorService(
      {} as never,
      {} as never,
      {} as never,
    );
    jest
      .spyOn(service as never, 'execute')
      .mockRejectedValue(new Error('manual attendance sync failed') as never);
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-12',
      scheduledAt: new Date('2026-09-12T01:30:00.000Z'),
    };

    expect(
      service.requestManualRetry(run, 'attendance-manual-20260912-004'),
    ).toMatchObject({
      accepted: true,
      inProgress: true,
      state: 'running',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.getRunStatus(run.task, run.date)).toMatchObject({
      state: 'failed',
      attemptCount: 1,
      maxAttempts: 1,
      failureReason: '考勤自动化执行失败',
      finalFailure: true,
    });
    expect(service.getRunStatus(run.task, run.date)).not.toHaveProperty(
      'nextRetryAt',
    );
  });

  it('keeps the unified 09:30 attendance card available when a historical approved leave has no valid period', async () => {
    const dingTalkClient = {
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-gu', name: '顾晓磊' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'current-white',
          scheduleDate: '2026-09-11',
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          dutyStaffReference: ['顾晓磊'],
          dutyStaffActual: ['顾晓磊'],
          leaveStaff: [],
          substituteStaff: [],
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([
        {
          recordId: 'legacy-incomplete-leave',
          leaveStaff: ['顾晓磊'],
          substituteStaff: [],
          startAt: null,
          endAt: null,
          building: 'building_c',
          team: '',
          shift: '',
          impactedScheduleRecordIds: [],
        },
      ]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest.fn().mockResolvedValue({
        total: 1,
        created: 1,
        updated: 0,
      }),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-10',
        fetchedAt: '2026-09-11 00:30',
        archiveRecordCount: 24,
        anomalies: [],
        normal: [],
        normalByBuilding: {},
        checkedTasks: [],
      }),
    };
    const dailySummaryStore = { mergeLiveCheck: jest.fn() };
    const patrol = {
      isEnabled: () => true,
      collectReport: jest.fn().mockResolvedValue({
        businessDate: '2026-09-11',
        startDate: '2026-09-11',
        endDate: '2026-09-18',
        generatedAt: '2026-09-11T01:30:00.000Z',
        evaluatedFacilityPoints: 7,
        checks: [],
        totalIssues: 0,
        hasAlerts: false,
      }),
      prepareMorningFollowUps: jest.fn().mockResolvedValue({
        recordIds: ['follow-up-1'],
        followUpCardId: 'b'.repeat(32),
      }),
      sendMorningBriefCard: jest.fn().mockResolvedValue('om_group'),
    };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as never,
      dutyScheduleService as never,
      feishuGateway as never,
      dailySummaryStore as never,
      patrol as never,
    );

    await expect(
      service.run({
        task: 'morning-off-duty-check',
        date: '2026-09-11',
        scheduledAt: new Date('2026-09-11T01:30:00.000Z'),
      }),
    ).resolves.toMatchObject({
      success: true,
      managementSummary: { sent: 1 },
    });
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
    expect(feishuGateway.archiveAttendance).toHaveBeenCalledTimes(1);
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(1);
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledWith(
      expect.any(Object),
      '2026-09-11',
      'unified-full-v4',
      'b'.repeat(32),
    );
    const serialized = JSON.stringify(
      patrol.sendMorningBriefCard.mock.calls[0][0],
    );
    expect(serialized).toContain('考勤异常 1 项');
    expect(serialized).not.toContain('考勤待核验');
    expect(serialized).toContain('today_operations_followup');
    expect(serialized).toContain('b'.repeat(32));
    expect(serialized).not.toContain('attendance-anomaly-follow-up');
    expect(patrol.prepareMorningFollowUps.mock.invocationCallOrder[0])
      .toBeLessThan(patrol.sendMorningBriefCard.mock.invocationCallOrder[0]);
  });

  it('runs independent overtime through the existing single scheduled pull and shares one verified leave snapshot with both schedule readers', async () => {
    const dingTalk = {
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-test', name: '加班甲' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
    };
    const duty = {
      getDutySchedules: jest.fn().mockResolvedValue([]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const gateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([
        {
          record_id: 'rec-ot',
          fields: {
            加班审批: '同意',
            加班流程进展: '已审批',
            加班工作流状态: '已审批',
            加班人员姓名: '加班甲',
            机楼: 'A楼',
            加班开始时间: '2026-09-08 08:00:00',
            加班结束时间: '2026-09-08 18:00:00',
          },
        },
      ]),
      archiveAttendance: jest.fn().mockResolvedValue({}),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
    };
    const store = { mergeLiveCheck: jest.fn() };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalk as never,
      duty as never,
      gateway as never,
      store as never,
    );
    const result: any = await service.run({
      task: 'evening-off-duty-check',
      date: '2026-09-08',
      scheduledAt: new Date('2026-09-08T18:35:00+08:00'),
    });
    expect(result.expected).toBe(2);
    expect(dingTalk.listAttendanceDetails).toHaveBeenCalledTimes(1);
    expect(dingTalk.listAttendanceDetails).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ['ding-test'] }),
      { budgetPriority: 'evening-final' },
    );
    expect(duty.getDutySchedules.mock.calls[0][2]).toBe(
      duty.getLongWhiteDutyStaff.mock.calls[0][2],
    );
    expect(duty.getDutySchedules.mock.calls[0][2]).toEqual({
      verified: true,
      requests: [],
    });
    expect(
      (gateway.archiveAttendance.mock.calls as any)[0][0].results,
    ).toHaveLength(2);
  });

  it('recomputes the live summary in the same run after correction evidence is archived', async () => {
    const correctionTime = Date.parse('2026-09-08T18:00:00+08:00');
    const correction = {
      processInstanceId: 'process-overtime-off-duty',
      userId: 'ding-test',
      status: 'COMPLETED',
      result: 'agree',
      correctionTime,
      workDate: Date.parse('2026-09-08T00:00:00+08:00'),
      planText: '加班下班缺卡',
      reason: '忘记打卡',
      photoUrls: ['https://static.dingtalk.com/media/evidence.jpg'],
      original: {},
    };
    const dingTalk = {
      listCorrectionApprovals: jest.fn().mockResolvedValue([correction]),
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-test', name: '加班甲' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
    };
    const duty = {
      getDutySchedules: jest.fn().mockResolvedValue([]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const gateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([
        {
          record_id: 'rec-ot',
          fields: {
            加班审批: '同意',
            加班流程进展: '已审批',
            加班工作流状态: '已审批',
            加班人员姓名: '加班甲',
            机楼: 'A楼',
            加班开始时间: '2026-09-08 08:00:00',
            加班结束时间: '2026-09-08 18:00:00',
          },
        },
      ]),
      archiveAttendance: jest.fn().mockResolvedValue({}),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
    };
    const store = { mergeLiveCheck: jest.fn().mockResolvedValue(undefined) };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalk as never,
      duty as never,
      gateway as never,
      store as never,
    );

    await service.run({
      task: 'evening-off-duty-check',
      date: '2026-09-08',
      scheduledAt: new Date('2026-09-08T18:35:00+08:00'),
    });

    expect(gateway.archiveAttendance).toHaveBeenCalledTimes(2);
    expect(gateway.archiveAttendance.mock.calls[1][0]).toMatchObject({
      corrections: [correction],
      results: expect.arrayContaining([
        expect.objectContaining({
          checkType: 'OffDuty',
          timeResult: 'Normal',
          correctionEvidenceStatus: 'present',
        }),
      ]),
    });
    expect(store.mergeLiveCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        normal: expect.arrayContaining([
          expect.objectContaining({ name: '加班甲', direction: 'OffDuty' }),
        ]),
        anomalies: expect.not.arrayContaining([
          expect.objectContaining({ name: '加班甲', direction: 'OffDuty' }),
        ]),
      }),
    );
  });

  it.each([
    {
      task: 'morning-on-duty-reminder',
      time: '08:55',
      scheduledAt: '2026-08-30T00:55:00.000Z',
      end: '2026-08-30 08:55:59',
      shift: 'white',
      shiftText: '白班',
    },
    {
      task: 'evening-on-duty-reminder',
      time: '17:55',
      scheduledAt: '2026-08-30T09:55:00.000Z',
      end: '2026-08-30 17:55:59',
      shift: 'night',
      shiftText: '夜班',
    },
  ] as const)(
    '$time only archives the live snapshot without sending a card',
    async (testCase) => {
      const dingTalkClient = {
        listAllUsers: jest
          .fn()
          .mockResolvedValue([{ userId: 'ding-gu', name: '顾晓磊' }]),
        listAttendanceResults: jest.fn(),
        listAttendanceDetails: jest.fn().mockResolvedValue([]),
        listCorrectionApprovals: jest.fn().mockResolvedValue([
          {
            processInstanceId: 'process-live-1',
            userId: 'ding-gu',
            status: 'COMPLETED',
            result: 'agree',
            correctionTime: Date.parse('2026-08-30T01:00:00.000Z'),
            workDate: Date.parse('2026-08-30T00:00:00.000Z'),
            planText: 'On duty missing card',
            reason: 'Forgot to punch',
            photoUrls: ['https://static.dingtalk.com/media/evidence.jpg'],
            original: {},
          },
        ]),
      };
      const dutyScheduleService = {
        getDutySchedules: jest.fn().mockResolvedValue([
          {
            id: `current-${testCase.shift}`,
            recordId: `current-${testCase.shift}`,
            dutyCode: `current-${testCase.shift}`,
            scheduleDate: '2026-08-30',
            code: null,
            building: 'building_c',
            team: 'team_1',
            shift: testCase.shift,
            personText: '顾晓磊',
            dutyStaffReference: ['顾晓磊'],
            dutyStaffActual: ['顾晓磊'],
            remark: '',
            emergencyDuty: '',
            emergencyDutySchedule: '',
            leaveStaff: [],
            substituteStaff: [],
            actualDutyStaff: '顾晓磊',
            buildingText: 'C楼',
            teamText: '一班',
            shiftText: testCase.shiftText,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ]),
        getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
      };
      const feishuGateway = {
        readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
        readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
        archiveAttendance: jest
          .fn()
          .mockResolvedValue({ total: 1, created: 1, updated: 0 }),
        resolveRecipients: jest.fn(),
        readArchivedAttendanceSummary: jest.fn(),
        resolvePersonalRecipients: jest.fn(),
        sendCard: jest.fn(),
      };
      const dailySummaryStore = { mergeLiveCheck: jest.fn() };
      const service = new AttendanceAutomationCoordinatorService(
        dingTalkClient as any,
        dutyScheduleService as any,
        feishuGateway as any,
        dailySummaryStore as any,
      );

      await service.run({
        task: testCase.task,
        date: '2026-08-30',
        scheduledAt: new Date(testCase.scheduledAt),
      });

      expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
      expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledWith({
        start: '2026-08-30 00:00:00',
        end: testCase.end,
        userIds: ['ding-gu'],
      });
      expect(dingTalkClient.listCorrectionApprovals).toHaveBeenCalledTimes(1);
      expect(feishuGateway.archiveAttendance).toHaveBeenCalledTimes(2);
      expect(feishuGateway.archiveAttendance).toHaveBeenLastCalledWith(
        expect.objectContaining({
          results: [
            expect.objectContaining({
              checkType: 'OnDuty',
              userId: 'ding-gu',
            }),
          ],
          details: [],
          corrections: [
            expect.objectContaining({
              processInstanceId: 'process-live-1',
              photoUrls: ['https://static.dingtalk.com/media/evidence.jpg'],
            }),
          ],
        }),
      );
      expect(feishuGateway.resolvePersonalRecipients).not.toHaveBeenCalled();
      expect(feishuGateway.resolveRecipients).not.toHaveBeenCalled();
      expect(
        feishuGateway.readArchivedAttendanceSummary,
      ).not.toHaveBeenCalled();
      expect(feishuGateway.sendCard).not.toHaveBeenCalled();
      expect(dailySummaryStore.mergeLiveCheck).not.toHaveBeenCalled();
      expect(
        readFileSync(
          join(stateDir, 'attendance-automation-task-state.json'),
          'utf8',
        ),
      ).toContain(`2026-08-30:${testCase.task}`);
    },
  );

  it('does not send the unified 09:30 card until DingTalk attendance data is available', async () => {
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockRejectedValue(new Error('live DingTalk unavailable')),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
      listAttendanceResults: jest.fn(),
      listCorrectionApprovals: jest.fn(),
    };
    const previousNight = {
      id: 'previous-night',
      recordId: 'previous-night',
      dutyCode: 'previous-night',
      scheduleDate: '2026-09-03',
      code: null,
      building: 'building_c',
      team: 'team_1',
      shift: 'night',
      personText: '顾晓磊',
      dutyStaffReference: ['顾晓磊'],
      dutyStaffActual: ['顾晓磊'],
      remark: '',
      emergencyDuty: '',
      emergencyDutySchedule: '',
      leaveStaff: [],
      substituteStaff: [],
      actualDutyStaff: '顾晓磊',
      buildingText: 'C楼',
      teamText: '一班',
      shiftText: '夜班',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([previousNight]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const archivedAnomalies = [
      {
        key: 'c-cao-on',
        name: '曹毅',
        building: 'C楼',
        shiftLabel: '白班',
        direction: 'OnDuty',
        expectedAt: '2026-09-03 09:00:00',
        status: 'on_duty',
        reason: '未打卡',
      },
      {
        key: 'h-zhi-off',
        name: '支佳伟',
        building: 'H楼',
        shiftLabel: '夜班',
        direction: 'OffDuty',
        expectedAt: '2026-09-03 09:00:00',
        status: 'on_duty',
        reason: '未打卡',
      },
      {
        key: 'station-chen-on',
        name: '陈建峰',
        building: '110站',
        shiftLabel: '白班',
        direction: 'OnDuty',
        expectedAt: '2026-09-03 08:00:00',
        status: 'on_duty',
        reason: '迟到',
      },
    ] as const;
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest.fn(),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-03',
        fetchedAt: '2026-09-04 00:31',
        anomalies: archivedAnomalies,
        normalByBuilding: { C楼: 2, H楼: 3, '110站': 1 },
      }),
      resolveRecipients: jest.fn().mockResolvedValue([
        { openId: 'ou_manager', name: '马进宇', scope: 'manager' },
        {
          openId: 'ou_c_supervisor',
          name: 'C楼主管',
          scope: 'building',
          building: 'C楼',
        },
        {
          openId: 'ou_station',
          name: '周海祥',
          scope: 'station',
          building: '110站',
        },
      ]),
      resolvePersonalRecipients: jest
        .fn()
        .mockResolvedValue([{ openId: 'ou_gu', name: '顾晓磊' }]),
      sendCard: jest.fn(async (openId: string) => `om_${openId}`),
    };
    const dailySummaryStore = {
      read: jest.fn(),
      write: jest.fn(),
    };
    const patrol = {
      isEnabled: () => true,
      collectReport: jest.fn().mockResolvedValue({
        businessDate: '2026-09-04',
        startDate: '2026-09-04',
        endDate: '2026-09-11',
        generatedAt: '2026-09-04T01:30:00.000Z',
        evaluatedFacilityPoints: 21,
        checks: [
          {
            check: 'facility',
            label: '用电 / PUE / 水耗',
            status: 'normal',
            count: 0,
            issues: [],
          },
          {
            check: 'weather',
            label: '天气告警',
            status: 'normal',
            count: 0,
            issues: [],
          },
        ],
        totalIssues: 0,
        hasAlerts: false,
      }),
      sendMorningBriefCard: jest.fn().mockResolvedValue('om_degraded_group'),
    };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
      patrol as any,
    );

    await expect(
      service.run({
        task: 'morning-off-duty-check',
        date: '2026-09-04',
        scheduledAt: new Date('2026-09-04T01:30:00.000Z'),
      }),
    ).rejects.toThrow('live DingTalk unavailable');

    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceDetails).not.toHaveBeenCalled();
    expect(feishuGateway.readArchivedAttendanceSummary).not.toHaveBeenCalled();
    expect(dailySummaryStore.read).not.toHaveBeenCalled();
    expect(feishuGateway.resolveRecipients).not.toHaveBeenCalled();
    expect(feishuGateway.resolvePersonalRecipients).not.toHaveBeenCalled();
    expect(feishuGateway.sendCard).not.toHaveBeenCalled();
    expect(patrol.collectReport).not.toHaveBeenCalled();
    expect(patrol.sendMorningBriefCard).not.toHaveBeenCalled();
    expect(
      service.getRunStatus('morning-off-duty-check', '2026-09-04'),
    ).toMatchObject({
      state: 'failed',
      task: 'morning-off-duty-check',
      date: '2026-09-04',
      scheduledAt: '2026-09-04T01:30:00.000Z',
      firstAttemptAt: expect.any(String),
      lastAttemptAt: expect.any(String),
      attemptCount: 1,
      maxAttempts: 6,
      failureReason: '钉钉考勤数据拉取失败',
      nextRetryAt: expect.any(String),
      retryCutoffAt: expect.any(String),
      finalFailure: false,
    });
  });

  it('marks the 09:30 run as final after the configured maximum attempts or retry window', async () => {
    process.env.ATTENDANCE_AUTOMATION_RETRY_MAX_ATTEMPTS = '2';
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockRejectedValue(new Error('live DingTalk unavailable')),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          id: 'previous-night',
          scheduleDate: '2026-09-03',
          building: 'building_c',
          team: 'team_1',
          shift: 'night',
          dutyStaffActual: ['顾晓磊'],
          dutyStaffReference: ['顾晓磊'],
          personText: '顾晓磊',
          leaveStaff: [],
          substituteStaff: [],
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
    };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      { mergeLiveCheck: jest.fn() } as any,
    );
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-04',
      scheduledAt: new Date('2026-09-04T01:30:00.000Z'),
    };

    await expect(service.run(run)).rejects.toThrow('钉钉考勤数据拉取失败');
    await expect(service.run(run)).rejects.toThrow('钉钉考勤数据拉取失败');

    expect(service.getRunStatus(run.task, run.date)).toMatchObject({
      state: 'failed',
      attemptCount: 2,
      maxAttempts: 2,
      failureReason: '钉钉考勤数据拉取失败',
      finalFailure: true,
    });
    expect(service.getRunStatus(run.task, run.date)).not.toHaveProperty(
      'nextRetryAt',
    );

    rmSync(stateDir, { recursive: true, force: true });
    stateDir = mkdtempSync(join(tmpdir(), 'attendance-automation-test-'));
    process.env.ATTENDANCE_AUTOMATION_STATE_DIR = stateDir;
    process.env.ATTENDANCE_AUTOMATION_RETRY_MAX_ATTEMPTS = '6';
    process.env.ATTENDANCE_AUTOMATION_RETRY_DELAY_MS = '120000';
    process.env.ATTENDANCE_AUTOMATION_RETRY_WINDOW_MINUTES = '1';
    const windowService = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      { mergeLiveCheck: jest.fn() } as any,
    );

    await expect(windowService.run(run)).rejects.toThrow(
      '钉钉考勤数据拉取失败',
    );
    expect(windowService.getRunStatus(run.task, run.date)).toMatchObject({
      state: 'failed',
      attemptCount: 1,
      maxAttempts: 6,
      finalFailure: true,
    });
    expect(windowService.getRunStatus(run.task, run.date)).not.toHaveProperty(
      'nextRetryAt',
    );
  });

  it('sends one green 09:30 attendance and patrol summary to the configured group', async () => {
    const archivedNormal = [
      { key: 'c-normal', name: 'C楼正常人员', building: 'C楼' },
      { key: 'h-normal', name: 'H楼正常人员', building: 'H楼' },
      { key: 'station-normal', name: '110站正常人员', building: '110站' },
    ].map((item) => ({
      ...item,
      shiftLabel: '白班',
      direction: 'OnDuty',
      expectedAt: '2026-09-04 09:00:00',
      status: 'on_duty',
    }));
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-04',
        fetchedAt: '2026-09-05 00:31',
        anomalies: [],
        normal: archivedNormal,
        normalByBuilding: { C楼: 2, H楼: 3, '110站': 1 },
        checkedTasks: [],
      }),
    };
    const patrol = {
      isEnabled: () => true,
      collectReport: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05',
        startDate: '2026-09-05',
        endDate: '2026-09-12',
        generatedAt: '2026-09-05T01:30:00.000Z',
        evaluatedFacilityPoints: 7,
        checks: [],
        totalIssues: 0,
        hasAlerts: false,
      }),
      sendMorningBriefCard: jest.fn().mockResolvedValue('om_group'),
    };
    const service = new AttendanceAutomationCoordinatorService(
      {} as any,
      {} as any,
      feishuGateway as any,
      undefined,
      patrol as any,
      undefined,
      { getDashboard: jest.fn().mockResolvedValue({ sourceStatus: 'fresh', summary: { tagAnomalyTotal: 0 } }) } as never,
    );

    const live = {
      success: true,
      task: 'morning-off-duty-check',
      date: '2026-09-05',
      source: 'dingtalk-scheduled-snapshot',
      expected: 0,
      anomalies: 0,
      normal: 0,
      deliveries: [],
      classification: { anomalies: [], excluded: [], normal: [] },
      fetchedAt: '2026-09-05 09:30',
    };
    await expect(
      (service as any).sendMorningManagementSummary(
        {
          task: 'morning-off-duty-check',
          date: '2026-09-05',
          scheduledAt: new Date('2026-09-05T01:30:00.000Z'),
        },
        live,
      ),
    ).resolves.toEqual({
      reportDate: '2026-09-05',
      archiveDate: '2026-09-04',
      sent: 1,
    });

    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(1);
    const [card, businessDate] = patrol.sendMorningBriefCard.mock.calls[0];
    expect(businessDate).toBe('2026-09-05');
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('南通每日运维巡视同步');
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('今日白班');
    expect(serialized).toContain('昨日白班');
    expect(serialized).toContain('昨日夜班');
    expect(serialized).toContain('考勤异常 0 项');
  });

  it('adds training only from the 25th and keeps sending when training fails', async () => {
    const gateway = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        fetchedAt: '2026-09-25 00:30',
        anomalies: [],
        normal: [],
        normalByBuilding: {},
        checkedTasks: [],
      }),
    };
    const patrol = {
      isEnabled: () => false,
      sendMorningBriefCard: jest.fn().mockResolvedValue('om_group'),
    };
    const training = {
      getMonthlyPatrolParticipation: jest.fn().mockResolvedValue([
        {
          building: 'B楼',
          people: 10,
          target: 10,
          trainingCompletionRate: 75,
          assessmentPassRate: 0,
        },
      ]),
    };
    const service = new AttendanceAutomationCoordinatorService(
      {} as never,
      {} as never,
      gateway as never,
      undefined,
      patrol as never,
      training as never,
    );
    const send = (date: string) =>
      (service as any).sendMorningManagementSummary(
        {
          task: 'morning-off-duty-check',
          date,
          scheduledAt: new Date(`${date}T01:30:00Z`),
        },
        {
          classification: { anomalies: [], normal: [], excluded: [] },
          fetchedAt: `${date} 09:30`,
        },
      );

    await send('2026-09-24');
    expect(training.getMonthlyPatrolParticipation).not.toHaveBeenCalled();
    await send('2026-09-25');
    expect(training.getMonthlyPatrolParticipation).toHaveBeenCalledWith(
      '2026-09',
    );
    expect(
      JSON.stringify(patrol.sendMorningBriefCard.mock.calls[1][0]),
    ).toContain('月度培训进展');

    training.getMonthlyPatrolParticipation.mockRejectedValueOnce(
      new Error('培训表暂时不可用'),
    );
    await expect(send('2026-09-26')).resolves.toMatchObject({ sent: 1 });
    expect(
      JSON.stringify(patrol.sendMorningBriefCard.mock.calls[2][0]),
    ).not.toContain('月度培训进展');
  });

  it('excludes newly approved leave and retries the single group brief idempotently', async () => {
    const event = {
      key: 'leave-punch',
      name: '施小东',
      building: 'A楼',
      shiftLabel: '白班',
      direction: 'OnDuty',
      expectedAt: '2026-09-07 09:00:00',
      status: 'on_duty',
      reason: '未打卡',
    };
    const gateway = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-07',
        fetchedAt: '2026-09-08 00:30',
        archiveRecordCount: 40000,
        anomalies: [
          event,
          { ...event, key: 'other', name: '测试乙', building: 'B楼' },
        ],
        normal: [],
        normalByBuilding: {},
        checkedTasks: [],
      }),
    };
    const patrol = {
      isEnabled: () => true,
      collectReport: jest.fn().mockResolvedValue({
        businessDate: '2026-09-08',
        startDate: '2026-09-08',
        endDate: '2026-09-15',
        generatedAt: '2026-09-08T01:30:00Z',
        evaluatedFacilityPoints: 7,
        checks: [],
        totalIssues: 0,
        hasAlerts: false,
      }),
      sendMorningBriefCard: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary delivery failure'))
        .mockResolvedValueOnce('om_group'),
    };
    const service = new AttendanceAutomationCoordinatorService(
      {} as never,
      {} as never,
      gateway as never,
      undefined,
      patrol as never,
    );
    const run = {
      task: 'morning-off-duty-check',
      date: '2026-09-08',
      scheduledAt: new Date('2026-09-08T01:30:00Z'),
    };
    const live = {
      classification: { anomalies: [], normal: [], excluded: [] },
      fetchedAt: '2026-09-08 09:30',
    };
    const approved = [
      {
        recordId: 'approved-leave',
        leaveStaff: ['施小东'],
        startAt: '2026-09-07T09:00:00+08:00',
        endAt: '2026-09-07T18:00:00+08:00',
        building: 'building_a',
      },
    ];
    await expect(
      (service as any).sendMorningManagementSummary(run, live, approved),
    ).rejects.toThrow('temporary delivery failure');
    await (service as any).sendMorningManagementSummary(run, live, approved);
    await expect(
      (service as any).sendMorningManagementSummary(run, live, approved),
    ).resolves.toMatchObject({ sent: 0 });
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(2);
    const cards = patrol.sendMorningBriefCard.mock.calls.map(([card]) =>
      JSON.stringify(card),
    );
    expect(cards.every((card) => !card.includes('施小东'))).toBe(true);
    expect(cards.every((card) => card.includes('测试乙'))).toBe(true);
    expect(cards.every((card) => card.includes('40,000'))).toBe(true);
  });

  it('delivers the 09:30 group card before retrying a failed attendance archive without duplicates', async () => {
    const dingTalkClient = {
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-gu', name: '顾晓磊' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([
        {
          id: 'detail-gu-on-duty',
          userId: 'ding-gu',
          checkType: 'OnDuty',
          userCheckTime: Date.parse('2026-09-08T01:00:00.000Z'),
          baseCheckTime: Date.parse('2026-09-08T01:00:00.000Z'),
          workDate: Date.parse('2026-09-08T00:00:00.000Z'),
          timeResult: 'Normal',
          locationResult: 'Normal',
          userAddress: '南通园区',
          userLongitude: null,
          userLatitude: null,
          outsideRemark: null,
          invalidRecordMsg: null,
          deviceId: null,
          sourceType: 'ATM',
          original: {},
        },
      ]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          id: 'current-white',
          recordId: 'current-white',
          dutyCode: 'current-white',
          scheduleDate: '2026-09-08',
          code: null,
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          personText: '顾晓磊',
          dutyStaffReference: ['顾晓磊'],
          dutyStaffActual: ['顾晓磊'],
          remark: '',
          emergencyDuty: '',
          emergencyDutySchedule: '',
          leaveStaff: [],
          substituteStaff: [],
          actualDutyStaff: '顾晓磊',
          buildingText: 'C楼',
          teamText: '一班',
          shiftText: '白班',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary archive failure'))
        .mockResolvedValue({ total: 1, created: 0, updated: 1 }),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-07',
        fetchedAt: '2026-09-08 00:30',
        archiveRecordCount: 24,
        anomalies: [],
        normal: [],
        normalByBuilding: { C楼: 24 },
        checkedTasks: [],
      }),
    };
    const dailySummaryStore = { mergeLiveCheck: jest.fn() };
    let completeCardMessageId = '';
    let completeCardPosts = 0;
    let completeCardUpdates = 0;
    const patrol = {
      isEnabled: () => true,
      collectReport: jest.fn().mockResolvedValue({
        businessDate: '2026-09-08',
        startDate: '2026-09-08',
        endDate: '2026-09-15',
        generatedAt: '2026-09-08T01:30:00.000Z',
        evaluatedFacilityPoints: 7,
        checks: [],
        totalIssues: 0,
        hasAlerts: false,
      }),
      sendMorningBriefCard: jest.fn(
        async (
          _card: object,
          _businessDate: string,
          deliveryIdentity?: string,
        ) => {
          expect(deliveryIdentity).toBe('unified-full-v4');
          if (completeCardMessageId) {
            completeCardUpdates += 1;
            return completeCardMessageId;
          }
          completeCardPosts += 1;
          completeCardMessageId = 'om_group';
          return completeCardMessageId;
        },
      ),
    };
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-08',
      scheduledAt: new Date('2026-09-08T01:30:00.000Z'),
    };
    writeFileSync(
      join(stateDir, 'attendance-automation-task-state.json'),
      `${JSON.stringify({
        version: 1,
        completed: {
          '2026-09-08:morning-brief:group': {
            completedAt: '2026-09-08T01:29:00.000Z',
          },
        },
        runs: {},
      })}\n`,
      'utf8',
    );

    const first = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
      patrol as any,
    );
    await expect(first.run(run)).resolves.toMatchObject({
      success: true,
      archiveFailure: expect.any(Error),
    });
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(1);
    expect(completeCardPosts).toBe(1);
    expect(completeCardUpdates).toBe(0);
    expect(first.getRunStatus(run.task, run.date)).toMatchObject({
      state: 'completed',
      date: run.date,
      completedAt: expect.any(String),
      archiveSyncFailureReason: '飞书考勤多维表同步失败',
    });
    expect(
      JSON.parse(
        readFileSync(
          join(stateDir, 'attendance-automation-task-state.json'),
          'utf8',
        ),
      ).completed,
    ).toHaveProperty('2026-09-08:morning-brief:group:v6-group-card-resilience');

    const restarted = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
      patrol as any,
    );
    await restarted.recoverPendingAttendanceArchives(
      new Date(Date.now() + 60 * 60_000),
    );
    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(1);
    expect(completeCardPosts).toBe(1);
    expect(completeCardUpdates).toBe(0);
    expect(restarted.getRunStatus(run.task, run.date)).toMatchObject({
      state: 'completed',
      date: run.date,
      completedAt: expect.any(String),
    });
    expect(
      restarted.getRunStatus(run.task, run.date)?.archiveSyncFailureReason,
    ).toBeUndefined();

    const completedRestart = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
      patrol as any,
    );
    await expect(completedRestart.run(run)).resolves.toMatchObject({
      success: true,
      skipped: true,
    });
    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(1);
    expect(completeCardPosts).toBe(1);
    expect(completeCardUpdates).toBe(0);
  });

  it('archives the exact yesterday date carried by the 00:30 run', async () => {
    const correction = {
      processInstanceId: 'proc-correction-1',
      userId: 'ding-substitute',
      status: 'COMPLETED',
      result: 'agree',
      correctionTime: Date.parse('2026-08-29T01:00:00.000Z'),
      workDate: Date.parse('2026-08-29T00:00:00.000Z'),
      planText: '上班卡',
      reason: '忘记打卡',
      photoUrls: ['https://static.dingtalk.com/evidence.jpg'],
      original: {},
    };
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-substitute', name: '顾晓磊' }]),
      listAttendanceResults: jest.fn().mockResolvedValue([
        {
          id: 1,
          userId: 'ding-substitute',
          checkType: 'OnDuty',
          baseCheckTime: Date.parse('2026-08-29T01:00:00.000Z'),
          userCheckTime: Date.parse('2026-08-29T01:02:00.000Z'),
          workDate: Date.parse('2026-08-29T00:00:00.000Z'),
          timeResult: 'Normal',
          locationResult: 'Normal',
          approveId: 'approve-1',
          procInstId: 'proc-correction-1',
          sourceType: 'APPROVE',
          original: {},
        },
      ]),
      listAttendanceDetails: jest.fn(),
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
      getCorrectionApprovalsByInstanceIds: jest
        .fn()
        .mockResolvedValue([correction]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          id: 'current-white',
          recordId: 'current-white',
          dutyCode: 'current-white',
          scheduleDate: '2026-08-29',
          code: null,
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          personText: '蒋杰',
          dutyStaffReference: ['蒋杰'],
          dutyStaffActual: ['顾晓磊'],
          remark: '',
          emergencyDuty: '',
          emergencyDutySchedule: '',
          leaveStaff: ['蒋杰'],
          substituteStaff: ['顾晓磊'],
          actualDutyStaff: '顾晓磊',
          buildingText: 'C楼',
          teamText: '一班',
          shiftText: '白班',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({
        date: '2026-08-29',
        buildings: [],
        total: 0,
        source: { tableId: '', viewId: '', staffField: '' },
      }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockResolvedValue({ total: 1, created: 1, updated: 0 }),
      readArchivedAttendanceCoverage: jest.fn().mockResolvedValue({}),
      readArchivedAttendanceRecheckTargets: jest.fn().mockResolvedValue([]),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-08-29',
        fetchedAt: '2026-08-30 00:31',
        anomalies: [
          {
            key: '2026-08-29:building_c:white:OffDuty:顾晓磊',
            name: '顾晓磊',
            building: 'C楼',
            shiftLabel: '白班',
            direction: 'OffDuty',
            expectedAt: '2026-08-29 18:00:00',
            status: 'substitute',
            reason: '未打卡',
          },
        ],
        normalByBuilding: { C楼: 1 },
      }),
    };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
    );

    await service.run({
      task: 'archive-yesterday',
      date: '2026-08-29',
      scheduledAt: new Date('2026-08-29T16:30:00.000Z'),
    });

    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceResults).toHaveBeenCalledWith({
      start: '2026-08-29 00:00:00',
      end: '2026-08-29 23:59:59',
      userIds: ['ding-substitute'],
    });
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledWith({
      start: '2026-08-29 00:00:00',
      end: '2026-08-29 23:59:59',
      userIds: ['ding-substitute'],
    });
    expect(
      dingTalkClient.getCorrectionApprovalsByInstanceIds,
    ).toHaveBeenCalledWith(['proc-correction-1']);
    expect(feishuGateway.archiveAttendance).toHaveBeenCalledWith(
      expect.objectContaining({
        businessDate: '2026-08-29',
        corrections: [correction],
      }),
    );
    const summary = JSON.parse(
      readFileSync(join(stateDir, 'attendance-daily-summary.json'), 'utf8'),
    );
    expect(summary.summaries['2026-08-29']).toMatchObject({
      businessDate: '2026-08-29',
      source: 'dingtalk-archive',
      expected: 2,
      normal: 1,
      anomalies: expect.arrayContaining([
        expect.objectContaining({
          name: '顾晓磊',
          status: 'substitute',
          reason: '未打卡',
        }),
      ]),
    });
  });

  it('uses a late raw off-duty punch when the 00:30 attendance result is still NotSigned', async () => {
    const expectedOffDuty = Date.parse('2026-09-15T10:00:00.000Z');
    const actualOffDuty = Date.parse('2026-09-15T12:07:11.000Z');
    const latePunch = {
      id: 'detail-tao-off-duty',
      userId: 'ding-tao',
      checkType: 'OffDuty',
      baseCheckTime: expectedOffDuty,
      userCheckTime: actualOffDuty,
      workDate: Date.parse('2026-09-14T16:00:00.000Z'),
      timeResult: 'Normal',
      locationResult: 'Normal',
      sourceType: 'USER',
      original: {},
    };
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-tao', name: '陶必亮' }]),
      listAttendanceResults: jest.fn().mockResolvedValue([
        {
          id: 'result-tao-on-duty',
          userId: 'ding-tao',
          checkType: 'OnDuty',
          baseCheckTime: Date.parse('2026-09-15T01:00:00.000Z'),
          userCheckTime: Date.parse('2026-09-15T00:45:00.000Z'),
          workDate: Date.parse('2026-09-14T16:00:00.000Z'),
          timeResult: 'Normal',
          locationResult: 'Normal',
          sourceType: 'USER',
          original: {},
        },
        {
          id: 'result-tao-off-duty-stale',
          userId: 'ding-tao',
          checkType: 'OffDuty',
          baseCheckTime: expectedOffDuty,
          userCheckTime: null,
          workDate: Date.parse('2026-09-14T16:00:00.000Z'),
          timeResult: 'NotSigned',
          locationResult: null,
          sourceType: 'SYSTEM',
          original: {},
        },
      ]),
      listAttendanceDetails: jest.fn().mockResolvedValue([latePunch]),
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
      getCorrectionApprovalsByInstanceIds: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          id: 'schedule-tao-white',
          recordId: 'schedule-tao-white',
          dutyCode: 'schedule-tao-white',
          scheduleDate: '2026-09-15',
          code: null,
          building: 'building_d',
          team: 'team_1',
          shift: 'white',
          personText: '陶必亮',
          dutyStaffReference: ['陶必亮'],
          dutyStaffActual: ['陶必亮'],
          remark: '',
          emergencyDuty: '',
          emergencyDutySchedule: '',
          leaveStaff: [],
          substituteStaff: [],
          actualDutyStaff: '陶必亮',
          buildingText: 'D楼',
          teamText: '一班',
          shiftText: '白班',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({
        date: '2026-09-15',
        buildings: [],
        total: 0,
        source: { tableId: '', viewId: '', staffField: '' },
      }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockResolvedValue({ total: 2, created: 0, updated: 1 }),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-15',
        fetchedAt: '2026-09-16 00:31',
        anomalies: [],
        normal: [],
        normalByBuilding: { D楼: 2 },
      }),
      readArchivedAttendanceRecheckTargets: jest.fn().mockResolvedValue([]),
    };
    const dailySummaryStore = { write: jest.fn().mockResolvedValue(undefined) };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
    );

    await service.run({
      task: 'archive-yesterday',
      date: '2026-09-15',
      scheduledAt: new Date('2026-09-15T16:30:00.000Z'),
    });

    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledWith({
      start: '2026-09-15 00:00:00',
      end: '2026-09-15 23:59:59',
      userIds: ['ding-tao'],
    });
    expect(feishuGateway.archiveAttendance).toHaveBeenCalledWith(
      expect.objectContaining({
        businessDate: '2026-09-15',
        details: [latePunch],
        results: expect.arrayContaining([
          expect.objectContaining({
            userId: 'ding-tao',
            checkType: 'OffDuty',
            userCheckTime: '2026-09-15 20:07:11',
            timeResult: 'Normal',
          }),
        ]),
      }),
    );
  });

  it('fully archives D-1 and rechecks only archived anomaly users from D-2 and D-3', async () => {
    const users = [
      { userId: 'ding-current', name: '当日值班员' },
      { userId: 'ding-d2-anomaly', name: 'D-2异常人员' },
      { userId: 'ding-d3-anomaly', name: 'D-3异常人员' },
      { userId: 'ding-normal', name: '历史正常人员' },
      { userId: 'ding-late-correction', name: '迟补卡人员' },
    ];
    const lateCorrection = {
      processInstanceId: 'proc-late-correction',
      userId: 'ding-late-correction',
      status: 'COMPLETED',
      result: 'agree',
      correctionTime: Date.parse('2026-08-25T01:00:00.000Z'),
      workDate: Date.parse('2026-08-24T16:00:00.000Z'),
      planText: '上班卡',
      reason: '补充举证',
      photoUrls: ['https://static.dingtalk.com/late-correction.jpg'],
      original: {},
    };
    const dingTalkClient = {
      listAllUsers: jest.fn().mockResolvedValue(users),
      listAttendanceResults: jest.fn().mockResolvedValue([]),
      listAttendanceDetails: jest.fn(),
      listCorrectionApprovals: jest.fn().mockResolvedValue([lateCorrection]),
      getCorrectionApprovalsByInstanceIds: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          id: 'd1-white',
          recordId: 'd1-white',
          dutyCode: 'd1-white',
          scheduleDate: '2026-09-04',
          code: null,
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          personText: '当日值班员',
          dutyStaffReference: ['当日值班员'],
          dutyStaffActual: ['当日值班员'],
          remark: '',
          emergencyDuty: '',
          emergencyDutySchedule: '',
          leaveStaff: [],
          substituteStaff: [],
          actualDutyStaff: '当日值班员',
          buildingText: 'C楼',
          teamText: '一班',
          shiftText: '白班',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const recheckTarget = (
      businessDate: string,
      userId: string,
      name: string,
    ) => ({
      businessDate,
      userId,
      expectation: {
        key: `${businessDate}:building_c:white:OnDuty:${name}`,
        name,
        building: 'C楼',
        shiftLabel: '白班',
        direction: 'OnDuty',
        expectedAt: `${businessDate} 09:00:00`,
        status: 'on_duty',
      },
    });
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockResolvedValue({ total: 0, created: 0, updated: 0 }),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-04',
        fetchedAt: '2026-09-05 00:31',
        anomalies: [],
        normal: [],
        normalByBuilding: { C楼: 2 },
        checkedTasks: [],
      }),
      readArchivedAttendanceRecheckTargets: jest
        .fn()
        .mockResolvedValue([
          recheckTarget('2026-09-03', 'ding-d2-anomaly', 'D-2异常人员'),
          recheckTarget('2026-09-02', 'ding-d3-anomaly', 'D-3异常人员'),
          recheckTarget('2026-08-25', 'ding-late-correction', '迟补卡人员'),
        ]),
    };
    const dailySummaryStore = { write: jest.fn().mockResolvedValue(undefined) };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
    );

    await service.run({
      task: 'archive-yesterday',
      date: '2026-09-04',
      scheduledAt: new Date('2026-09-04T16:30:00.000Z'),
    });

    expect(
      feishuGateway.readArchivedAttendanceRecheckTargets,
    ).toHaveBeenCalledWith(['2026-09-03', '2026-09-02', '2026-08-25']);
    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceResults).toHaveBeenNthCalledWith(1, {
      start: '2026-09-04 00:00:00',
      end: '2026-09-04 23:59:59',
      userIds: users.map((user) => user.userId),
    });
    expect(dingTalkClient.listAttendanceResults).toHaveBeenNthCalledWith(2, {
      start: '2026-09-03 00:00:00',
      end: '2026-09-03 23:59:59',
      userIds: ['ding-d2-anomaly'],
    });
    expect(dingTalkClient.listAttendanceResults).toHaveBeenNthCalledWith(3, {
      start: '2026-09-02 00:00:00',
      end: '2026-09-02 23:59:59',
      userIds: ['ding-d3-anomaly'],
    });
    expect(dingTalkClient.listAttendanceResults).toHaveBeenNthCalledWith(4, {
      start: '2026-08-25 00:00:00',
      end: '2026-08-25 23:59:59',
      userIds: ['ding-late-correction'],
    });
    expect(dingTalkClient.listAttendanceResults).toHaveBeenCalledTimes(4);
    expect(
      dingTalkClient.listAttendanceResults.mock.calls
        .slice(1)
        .flatMap(([query]) => query.userIds),
    ).not.toContain('ding-normal');
    expect(feishuGateway.archiveAttendance).toHaveBeenCalledWith(
      expect.objectContaining({
        businessDate: '2026-08-25',
        corrections: [lateCorrection],
        results: [
          expect.objectContaining({
            procInstId: 'proc-late-correction',
            timeResult: 'Normal',
          }),
        ],
      }),
    );
  });

  it('does not expose a separate personal catch-up entry point', () => {
    expect(
      'runTodayPersonalCatchUp' in
        AttendanceAutomationCoordinatorService.prototype,
    ).toBe(false);
  });
});

describe('deriveAttendanceResults correction reconciliation', () => {
  it('links an approved correction when the APPROVE attendance row has no process instance id', () => {
    const expectedAt = '2026-09-04 18:00:00';
    const correctedAt = Date.parse('2026-09-04T10:00:00.000Z');
    const results = deriveAttendanceResults(
      [
        {
          key: '2026-09-04:building_a:white:OffDuty:徐志远',
          name: '徐志远',
          building: 'A楼',
          shiftLabel: '白班',
          direction: 'OffDuty',
          expectedAt,
          status: 'on_duty',
        },
      ],
      [{ userId: 'ding-xu', name: '徐志远' }],
      [],
      [
        {
          id: 'approve-result-without-instance-id',
          userId: 'ding-xu',
          checkType: 'OffDuty',
          baseCheckTime: correctedAt,
          userCheckTime: null,
          workDate: Date.parse('2026-09-03T16:00:00.000Z'),
          timeResult: 'NotSigned',
          locationResult: null,
          approveId: null,
          procInstId: null,
          sourceType: 'APPROVE',
          original: {},
        },
      ],
      [
        {
          processInstanceId: 'proc-correction-xu-0904',
          userId: 'ding-xu',
          status: 'COMPLETED',
          result: 'agree',
          correctionTime: correctedAt,
          workDate: Date.parse('2026-09-03T16:00:00.000Z'),
          planText: '下班卡',
          reason: '忘记打卡',
          photoUrls: ['https://static.dingtalk.com/evidence-xu.jpg'],
          original: {},
        },
      ],
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      procInstId: 'proc-correction-xu-0904',
      sourceType: 'APPROVE',
      userCheckTime: correctedAt,
      timeResult: 'Normal',
      correctionEvidenceStatus: 'present',
    });
    expect(results[0].original).toMatchObject({
      processInstanceId: 'proc-correction-xu-0904',
    });
  });

  it('does not attach a correction from a different shift direction', () => {
    const expectedAt = '2026-09-04 18:00:00';
    const correctedAt = Date.parse('2026-09-04T10:00:00.000Z');
    const [result] = deriveAttendanceResults(
      [
        {
          key: '2026-09-04:building_a:white:OffDuty:徐志远',
          name: '徐志远',
          building: 'A楼',
          shiftLabel: '白班',
          direction: 'OffDuty',
          expectedAt,
          status: 'on_duty',
        },
      ],
      [{ userId: 'ding-xu', name: '徐志远' }],
      [],
      [],
      [
        {
          processInstanceId: 'proc-on-duty',
          userId: 'ding-xu',
          status: 'COMPLETED',
          result: 'agree',
          correctionTime: correctedAt,
          workDate: Date.parse('2026-09-03T16:00:00.000Z'),
          planText: '上班卡',
          reason: '忘记打卡',
          photoUrls: ['https://static.dingtalk.com/evidence-xu.jpg'],
          original: {},
        },
      ],
    );

    expect(result).toMatchObject({
      procInstId: null,
      timeResult: 'NotSigned',
    });
    expect(result.correctionEvidenceStatus).toBeUndefined();
  });
});

describe('attendance correction discovery snapshots', () => {
  const originalEnv = process.env;
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'attendance-correction-discovery-'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_STATE_DIR: stateDir,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('keeps archived punch data reusable while retrying a failed correction query', async () => {
    const run = {
      task: 'archive-yesterday' as const,
      date: '2026-09-16',
      scheduledAt: new Date('2026-09-16T16:30:00.000Z'),
    };
    const query = {
      start: '2026-09-16 00:00:00',
      end: '2026-09-16 23:59:59',
    };
    const correction = {
      processInstanceId: 'process-test',
      userId: 'ding-test',
      status: 'COMPLETED',
      result: 'agree',
      correctionTime: Date.parse('2026-09-16T10:00:00.000Z'),
      workDate: Date.parse('2026-09-15T16:00:00.000Z'),
      planText: '下班卡',
      reason: '忘记打卡',
      photoUrls: [],
      original: {},
    };
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-test', name: '测试员工' }]),
      listAttendanceResults: jest.fn().mockResolvedValue([]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
      listCorrectionApprovals: jest
        .fn()
        .mockRejectedValueOnce(new Error('approval unavailable'))
        .mockResolvedValueOnce([correction]),
      getCorrectionApprovalsByInstanceIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      {} as any,
      {} as any,
    );
    const loadSnapshot = (
      service as unknown as {
        loadOrCaptureSnapshot: (
          inputRun: typeof run,
          inputQuery: typeof query,
          mode: 'archive',
        ) => Promise<{ corrections: unknown[] }>;
      }
    ).loadOrCaptureSnapshot.bind(service);

    await expect(loadSnapshot(run, query, 'archive')).rejects.toThrow(
      'approval unavailable',
    );
    await expect(loadSnapshot(run, query, 'archive')).resolves.toMatchObject({
      corrections: [correction],
    });
    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceResults).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listCorrectionApprovals).toHaveBeenCalledTimes(2);
  });

  it('recaptures a v3 archive snapshot so late raw punches are not hidden by the old cache', async () => {
    const run = {
      task: 'archive-yesterday' as const,
      date: '2026-09-14',
      scheduledAt: new Date('2026-09-14T16:30:00.000Z'),
    };
    const query = {
      start: '2026-09-14 00:00:00',
      end: '2026-09-14 23:59:59',
    };
    const latePunch = {
      id: 'detail-late-off-duty',
      userId: 'ding-late',
      checkType: 'OffDuty',
      baseCheckTime: Date.parse('2026-09-14T10:00:00.000Z'),
      userCheckTime: Date.parse('2026-09-14T12:07:11.000Z'),
      workDate: Date.parse('2026-09-13T16:00:00.000Z'),
      timeResult: 'Normal',
      locationResult: 'Normal',
      sourceType: 'USER',
      original: {},
    };
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-late', name: '晚打卡人员' }]),
      listAttendanceResults: jest.fn().mockResolvedValue([]),
      listAttendanceDetails: jest.fn().mockResolvedValue([latePunch]),
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
      getCorrectionApprovalsByInstanceIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      {} as any,
      {} as any,
    );
    (
      service as unknown as {
        writeSnapshot: (inputRun: typeof run, snapshot: unknown) => void;
      }
    ).writeSnapshot(run, {
      version: 3,
      task: run.task,
      date: run.date,
      mode: 'archive',
      capturedAt: '2026-09-14T16:31:00.000Z',
      query,
      correctionQuery: {
        start: '2026-09-02 00:00:00',
        end: '2026-09-15 00:30:00',
      },
      users: [{ userId: 'ding-late', name: '晚打卡人员' }],
      results: [],
      details: [],
      corrections: [],
    });

    const snapshot = await (
      service as unknown as {
        loadOrCaptureSnapshot: (
          inputRun: typeof run,
          inputQuery: typeof query,
          mode: 'archive',
        ) => Promise<{ version: number; details: unknown[] }>;
      }
    ).loadOrCaptureSnapshot(run, query, 'archive');

    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledWith({
      ...query,
      userIds: ['ding-late'],
    });
    expect(snapshot).toMatchObject({ version: 4, details: [latePunch] });
  });

  it('discovers recent approval instances independently of attendance result ids', async () => {
    const correction = {
      processInstanceId: 'proc-correction-xu-0904',
      userId: 'ding-xu',
      status: 'COMPLETED',
      result: 'agree',
      correctionTime: Date.parse('2026-09-04T10:00:00.000Z'),
      workDate: Date.parse('2026-09-03T16:00:00.000Z'),
      planText: '下班卡',
      reason: '忘记打卡',
      photoUrls: ['https://static.dingtalk.com/evidence-xu.jpg'],
      original: {},
    };
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-xu', name: '徐志远' }]),
      listAttendanceResults: jest.fn().mockResolvedValue([
        {
          id: 'approve-without-instance-id',
          userId: 'ding-xu',
          checkType: 'OffDuty',
          baseCheckTime: correction.correctionTime,
          userCheckTime: null,
          workDate: correction.workDate,
          timeResult: 'NotSigned',
          locationResult: null,
          approveId: null,
          procInstId: null,
          sourceType: 'APPROVE',
          original: {},
        },
      ]),
      listAttendanceDetails: jest.fn(),
      listCorrectionApprovals: jest.fn().mockResolvedValue([correction]),
      getCorrectionApprovalsByInstanceIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      {} as any,
      {} as any,
    );
    const run = {
      task: 'archive-yesterday' as const,
      date: '2026-09-14',
      scheduledAt: new Date('2026-09-14T16:30:00.000Z'),
    };

    const snapshot = await (
      service as unknown as {
        loadOrCaptureSnapshot: (
          inputRun: typeof run,
          query: { start: string; end: string },
          mode: 'archive',
        ) => Promise<{ corrections: (typeof correction)[] }>;
      }
    ).loadOrCaptureSnapshot(
      run,
      { start: '2026-09-14 00:00:00', end: '2026-09-14 23:59:59' },
      'archive',
    );

    expect(dingTalkClient.listCorrectionApprovals).toHaveBeenCalledWith({
      start: '2026-09-02 00:00:00',
      end: '2026-09-15 00:30:00',
    });
    expect(
      dingTalkClient.getCorrectionApprovalsByInstanceIds,
    ).toHaveBeenCalledWith([]);
    expect(snapshot.corrections).toEqual([correction]);
  });
});
