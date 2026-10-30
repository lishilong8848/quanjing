import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttendanceDailySummaryStore } from './attendance-daily-summary.store';
import type { AttendanceAutomationFeishuGateway } from './attendance-automation-feishu.gateway';
import { AttendanceAutomationCoordinatorService } from './attendance-automation-coordinator.service';
import type { DailyOperationsPatrolService } from './daily-operations-patrol.service';
import type { DingTalkAttendanceClient } from './dingtalk-attendance.client';
import type { DutyScheduleService } from './duty-schedule.service';
import type { TodayOperationsAlarmService } from '../bitable-sync/today-operations-alarm.service';

describe('AttendanceAutomationCoordinatorService morning brief', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...previousEnv };
    jest.restoreAllMocks();
  });

  it('bounds a stalled alarm read without blocking the morning card indefinitely', async () => {
    jest.useFakeTimers();
    const service = new AttendanceAutomationCoordinatorService(
      {} as DingTalkAttendanceClient, {} as DutyScheduleService,
      {} as AttendanceAutomationFeishuGateway, {} as AttendanceDailySummaryStore,
      undefined, undefined,
      { getDashboard: () => new Promise(() => {}) } as unknown as TodayOperationsAlarmService,
    );
    const read = (service as any).readMorningAlarmDashboard('2026-09-07');
    await jest.advanceTimersByTimeAsync(8_000);
    await expect(read).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the 09:30 attendance check complete when correction discovery fails', async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), 'attendance-correction-isolation-'),
    );
    process.env.ATTENDANCE_AUTOMATION_STATE_DIR = stateDir;
    process.env.PUBLIC_BASE_URL = 'https://sm.example.com';
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-17',
      scheduledAt: new Date('2026-09-17T01:30:00.000Z'),
    };
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-test', name: '测试员工' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
      listCorrectionApprovals: jest
        .fn()
        .mockRejectedValue(new Error('approval api unavailable')),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'white-test',
          scheduleDate: run.date,
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          dutyStaffReference: ['测试员工'],
          dutyStaffActual: ['测试员工'],
          leaveStaff: [],
          substituteStaff: [],
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
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
      sendSyncFailureAlert: jest.fn().mockResolvedValue(undefined),
    };
    const dailySummaryStore = { mergeLiveCheck: jest.fn() };
    try {
      const service = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        feishuGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
      );
      const sendMorningManagementSummary = jest
        .spyOn(service as never, 'sendMorningManagementSummary')
        .mockResolvedValue({
          reportDate: run.date,
          archiveDate: '2026-09-16',
          sent: 1,
        } as never);

      await expect(service.run(run)).resolves.toMatchObject({ success: true });
      expect(dailySummaryStore.mergeLiveCheck).toHaveBeenCalledTimes(1);
      expect(sendMorningManagementSummary).toHaveBeenCalledTimes(1);
      expect(service.getRunStatus(run.task, run.date)).toMatchObject({
        state: 'completed',
        correctionSyncFailureReason: '钉钉补卡审批查询失败',
      });
      await (service as any).notifyPendingSyncFailures();
      await (service as any).notifyPendingSyncFailures();
      expect(feishuGateway.sendSyncFailureAlert).toHaveBeenCalledTimes(1);
      expect(feishuGateway.sendSyncFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          task: run.task,
          date: run.date,
          stage: 'correction',
          detail: expect.stringContaining('approval api unavailable'),
        }),
      );
      await expect(service.run(run)).resolves.toMatchObject({ skipped: true });
      expect(dingTalkClient.listCorrectionApprovals).toHaveBeenCalledTimes(1);

      dingTalkClient.listCorrectionApprovals.mockResolvedValue([]);
      const restarted = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        feishuGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
      );
      await restarted.recoverPendingCorrections(
        new Date(Date.now() + 60 * 60_000),
      );
      expect(dingTalkClient.listCorrectionApprovals).toHaveBeenCalledTimes(2);
      expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
      expect(sendMorningManagementSummary).toHaveBeenCalledTimes(1);
      expect(restarted.getRunStatus(run.task, run.date)).toMatchObject({
        state: 'completed',
      });
      expect(
        restarted.getRunStatus(run.task, run.date)?.correctionSyncFailureReason,
      ).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('completes the live check and retries only the persisted Feishu archive after a write failure', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'attendance-archive-outbox-'));
    process.env.ATTENDANCE_AUTOMATION_STATE_DIR = stateDir;
    process.env.PUBLIC_BASE_URL = 'https://sm.example.com';
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-20',
      scheduledAt: new Date('2026-09-20T01:30:00.000Z'),
    };
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-test', name: '测试员工' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'white-test',
          scheduleDate: run.date,
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          dutyStaffReference: ['测试员工'],
          dutyStaffActual: ['测试员工'],
          leaveStaff: [],
          substituteStaff: [],
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockRejectedValueOnce(new Error('bitable timeout'))
        .mockResolvedValueOnce({ total: 1, created: 1, updated: 0 }),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
      sendSyncFailureAlert: jest.fn().mockResolvedValue(undefined),
    };
    const dailySummaryStore = {
      mergeLiveCheck: jest.fn().mockResolvedValue(undefined),
    };
    try {
      const service = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        feishuGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
      );
      jest
        .spyOn(service as never, 'sendMorningManagementSummary')
        .mockResolvedValue({
          reportDate: run.date,
          archiveDate: '2026-09-19',
          sent: 1,
        } as never);

      await expect(service.run(run)).resolves.toMatchObject({ success: true });
      expect(dailySummaryStore.mergeLiveCheck).toHaveBeenCalledTimes(1);
      expect(service.getRunStatus(run.task, run.date)).toMatchObject({
        state: 'completed',
        archiveSyncFailureReason: '飞书考勤多维表同步失败',
      });
      await (service as any).notifyPendingSyncFailures();
      await (service as any).notifyPendingSyncFailures();
      expect(feishuGateway.sendSyncFailureAlert).toHaveBeenCalledTimes(1);
      expect(feishuGateway.sendSyncFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          task: run.task,
          date: run.date,
          stage: 'archive',
          detail: expect.stringContaining('bitable timeout'),
        }),
      );

      const restarted = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        feishuGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
      );
      await restarted.recoverPendingAttendanceArchives(
        new Date(Date.now() + 60 * 60_000),
      );

      expect(feishuGateway.archiveAttendance).toHaveBeenCalledTimes(2);
      expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
      expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
      expect(
        restarted.getRunStatus(run.task, run.date)?.archiveSyncFailureReason,
      ).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('archives raw yesterday punches when correction discovery fails, then recovers separately', async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), 'attendance-archive-correction-'),
    );
    process.env.ATTENDANCE_AUTOMATION_STATE_DIR = stateDir;
    const run = {
      task: 'archive-yesterday' as const,
      date: '2026-09-16',
      scheduledAt: new Date('2026-09-16T16:30:00.000Z'),
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
        .mockResolvedValueOnce([]),
      getCorrectionApprovalsByInstanceIds: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'white-test',
          scheduleDate: run.date,
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          dutyStaffReference: ['测试员工'],
          dutyStaffActual: ['测试员工'],
          leaveStaff: [],
          substituteStaff: [],
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockResolvedValue({ total: 2, created: 2, updated: 0 }),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: run.date,
        fetchedAt: '2026-09-17 00:31',
        anomalies: [],
        normal: [],
        normalByBuilding: { C楼: 2 },
      }),
      readArchivedAttendanceRecheckTargets: jest.fn().mockResolvedValue([]),
    };
    const dailySummaryStore = { write: jest.fn().mockResolvedValue(undefined) };
    try {
      const service = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        feishuGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
      );
      await expect(service.run(run)).resolves.toMatchObject({ success: true });
      expect(feishuGateway.archiveAttendance).toHaveBeenCalledTimes(1);
      expect(dailySummaryStore.write).toHaveBeenCalledTimes(1);
      expect(service.getRunStatus(run.task, run.date)).toMatchObject({
        state: 'completed',
        correctionSyncFailureReason: '钉钉补卡审批查询失败',
      });
      await service.recoverPendingCorrections(
        new Date(Date.now() + 60 * 60_000),
      );
      expect(dingTalkClient.listAttendanceResults).toHaveBeenCalledTimes(1);
      expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
      expect(dingTalkClient.listCorrectionApprovals).toHaveBeenCalledTimes(2);
      expect(feishuGateway.archiveAttendance).toHaveBeenCalledTimes(1);
      expect(
        service.getRunStatus(run.task, run.date)?.correctionSyncFailureReason,
      ).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('retries only Feishu after correction discovery succeeded but its write failed', async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), 'attendance-correction-write-'),
    );
    process.env.ATTENDANCE_AUTOMATION_STATE_DIR = stateDir;
    process.env.PUBLIC_BASE_URL = 'https://sm.example.com';
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-17',
      scheduledAt: new Date('2026-09-17T01:30:00.000Z'),
    };
    const correction = {
      processInstanceId: 'approval-1',
      userId: 'ding-test',
      status: 'COMPLETED',
      result: 'agree',
      correctionTime: Date.parse('2026-09-16T10:00:00.000Z'),
      workDate: Date.parse('2026-09-16T00:00:00.000Z'),
      planText: '下班卡',
      reason: '忘记打卡',
      photoUrls: [],
      original: {},
    };
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-test', name: '测试员工' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
      listCorrectionApprovals: jest.fn().mockResolvedValue([correction]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'white-test',
          scheduleDate: run.date,
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          dutyStaffReference: ['测试员工'],
          dutyStaffActual: ['测试员工'],
          leaveStaff: [],
          substituteStaff: [],
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      readArchivedAttendanceRecheckTargets: jest.fn().mockResolvedValue([
        {
          businessDate: '2026-09-16',
          userId: 'ding-test',
          expectation: { key: 'corrected-punch' },
        },
        {
          businessDate: '2026-09-16',
          userId: 'another-user',
          expectation: { key: 'unrelated-punch' },
        },
      ]),
      archiveAttendance: jest
        .fn()
        .mockResolvedValueOnce({ total: 1, created: 1, updated: 0 })
        .mockRejectedValueOnce(new Error('bitable unavailable'))
        .mockRejectedValueOnce(new Error('bitable still unavailable'))
        .mockResolvedValueOnce({ total: 1, created: 0, updated: 1 }),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
    };
    const dailySummaryStore = {
      mergeLiveCheck: jest.fn().mockResolvedValue(undefined),
    };
    try {
      const service = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        feishuGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
      );
      jest
        .spyOn(service as never, 'sendMorningManagementSummary')
        .mockResolvedValue({
          reportDate: run.date,
          archiveDate: '2026-09-16',
          sent: 1,
        } as never);
      await expect(service.run(run)).resolves.toMatchObject({ success: true });
      expect(
        service.getRunStatus(run.task, run.date)?.correctionSyncFailureReason,
      ).toBeDefined();

      const restarted = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        feishuGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
      );
      const recheck = jest
        .spyOn(restarted as never, 'recheckArchivedAnomalies')
        .mockResolvedValue({ targets: 1, archived: 1 } as never);
      await restarted.recoverPendingCorrections(
        new Date(Date.now() + 60 * 60_000),
      );
      expect(restarted.getRunStatus(run.task, run.date)).toMatchObject({
        correctionSyncFailureReason: '补卡记录及举证同步失败',
      });
      expect(recheck).not.toHaveBeenCalled();
      await restarted.recoverPendingCorrections(
        new Date(Date.now() + 2 * 60 * 60_000),
      );
      expect(dingTalkClient.listCorrectionApprovals).toHaveBeenCalledTimes(1);
      expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
      expect(feishuGateway.archiveAttendance).toHaveBeenCalledTimes(4);
      expect(feishuGateway.archiveAttendance).toHaveBeenLastCalledWith(
        expect.objectContaining({
          results: [],
          details: [],
          corrections: [correction],
        }),
      );
      expect(
        feishuGateway.readArchivedAttendanceRecheckTargets,
      ).toHaveBeenCalledWith(['2026-09-16']);
      expect(recheck).toHaveBeenCalledWith(
        run.date,
        '2026-09-16',
        [
          {
            businessDate: '2026-09-16',
            userId: 'ding-test',
            expectation: { key: 'corrected-punch' },
          },
        ],
        [correction],
      );
      expect(
        restarted.getRunStatus(run.task, run.date)?.correctionSyncFailureReason,
      ).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(['positive', 'zero', 'failure', 'stale'] as const)('sends one full-campus card including yesterday alarm tags in %s mode', async (mode) => {
    process.env.PUBLIC_BASE_URL = 'https://sm.example.com';
    const attendanceGateway = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        archiveRecordCount: 10,
        businessDate: '2026-09-07',
        fetchedAt: '2026-09-07 09:35',
        anomalies: [],
        normal: [],
        normalByBuilding: {},
        checkedTasks: [],
      }),
      resolveRecipients: jest
        .fn()
        .mockResolvedValue([
          { openId: 'ou_manager', name: '管理员', scope: 'manager' },
        ]),
      sendCard: jest.fn().mockResolvedValue('om_private'),
    };
    const patrolService = {
      isEnabled: jest.fn().mockReturnValue(true),
      collectReport: jest.fn().mockResolvedValue({
        businessDate: '2026-09-08',
        startDate: '2026-09-08',
        endDate: '2026-09-15',
        generatedAt: '2026-09-08T01:35:00.000Z',
        evaluatedFacilityPoints: 3,
        checks: [
          {
            key: 'facility',
            label: '用电 / PUE / 水耗',
            status: 'normal',
            count: 0,
            summary: '正常',
            issues: [],
          },
        ],
        totalIssues: 0,
        hasAlerts: false,
      }),
      prepareMorningFollowUps: jest.fn().mockResolvedValue({
        recordIds: ['recAttendance'],
        followUpCardId: '0123456789abcdef0123456789abcdef',
      }),
      sendMorningBriefCard: jest.fn().mockResolvedValue('om_group'),
    };
    const alarmService = {
      getDashboard: mode === 'failure'
        ? jest.fn().mockRejectedValue(new Error('alarm source unavailable'))
        : jest.fn().mockResolvedValue({
          sourceStatus: mode === 'stale' ? 'stale' : 'fresh',
          summary: { tagAnomalyTotal: mode === 'zero' ? 0 : 2 },
        }),
    };
    const service = new AttendanceAutomationCoordinatorService(
      {} as DingTalkAttendanceClient,
      {} as DutyScheduleService,
      attendanceGateway as unknown as AttendanceAutomationFeishuGateway,
      {} as AttendanceDailySummaryStore,
      patrolService as unknown as DailyOperationsPatrolService,
      undefined,
      alarmService as unknown as TodayOperationsAlarmService,
    );
    jest
      .spyOn(service as never, 'readState')
      .mockReturnValue({ version: 1, completed: {} });
    jest.spyOn(service as never, 'markCompleted').mockImplementation();

    const result = await (
      service as unknown as {
        sendMorningManagementSummary: (
          run: { task: 'morning-off-duty-check'; date: string },
          live: unknown,
          approvedLeave: unknown[],
          overtimeRecords: unknown[],
        ) => Promise<{ sent: number }>;
      }
    ).sendMorningManagementSummary(
      { task: 'morning-off-duty-check', date: '2026-09-08' },
      {
        success: true,
        task: 'morning-off-duty-check',
        date: '2026-09-08',
        source: 'dingtalk-scheduled-snapshot',
        expected: 2,
        anomalies: 1,
        normal: 1,
        deliveries: [],
        classification: {
          anomalies: [
            {
              key: '2026-09-08:station_110:white:OnDuty:邱少剑',
              name: '邱少剑',
              building: '110站',
              shiftLabel: '白班',
              direction: 'OnDuty',
              expectedAt: '2026-09-08 08:30:00',
              status: 'on_duty',
              reason: '迟到',
            },
          ],
          excluded: [],
          normal: [
            {
              key: '2026-09-08:building_a:white:OnDuty:测试正常人员',
              name: '测试正常人员',
              building: 'A楼',
              shiftLabel: '白班',
              direction: 'OnDuty',
              expectedAt: '2026-09-08 08:30:00',
              status: 'on_duty',
            },
          ],
        },
        fetchedAt: '2026-09-08 09:35',
      },
      [],
      [],
    );

    expect(result.sent).toBe(1);
    expect(attendanceGateway.resolveRecipients).not.toHaveBeenCalled();
    expect(attendanceGateway.sendCard).not.toHaveBeenCalled();
    expect(patrolService.sendMorningBriefCard).toHaveBeenCalledTimes(1);
    expect(patrolService.prepareMorningFollowUps).toHaveBeenCalledTimes(1);
    expect(
      patrolService.prepareMorningFollowUps.mock.invocationCallOrder[0],
    ).toBeLessThan(
      patrolService.sendMorningBriefCard.mock.invocationCallOrder[0],
    );
    const [card, businessDate] =
      patrolService.sendMorningBriefCard.mock.calls[0];
    expect(businessDate).toBe('2026-09-08');
    expect(JSON.stringify(card)).toContain('110站');
    expect(JSON.stringify(card)).toContain('邱少剑');
    expect(JSON.stringify(card)).toContain('异常跟进');
    expect(JSON.stringify(card)).not.toContain('ticket=signed.ticket');
    expect(patrolService.sendMorningBriefCard).toHaveBeenCalledWith(
      card, businessDate, 'unified-full-v4', '0123456789abcdef0123456789abcdef',
    );
    expect(alarmService.getDashboard).toHaveBeenCalledWith({ date: '2026-09-07', metric: 'tagAnomaly', pageSize: '1' });
    if (mode === 'positive') {
      expect(JSON.stringify(card)).toContain('昨日告警异常打标 2 项，需要跟踪处理');
      expect(JSON.stringify(card)).toContain('https://sm.example.com/alarm-tag-anomalies?date=2026-09-07');
    } else if (mode === 'zero') {
      expect(JSON.stringify(card)).not.toContain('查看告警异常');
      expect(JSON.stringify(card)).not.toContain('昨日告警打标数据暂不可用');
    } else {
      expect(JSON.stringify(card)).toContain('昨日告警打标数据暂不可用');
      expect(JSON.stringify(card)).not.toContain('昨日告警异常打标 2 项');
    }
  });

  it.each([
    {
      failureMode: 'recipient resolution',
      expectedError: '个人异常接收人读取失败：陈奇未匹配到唯一 Open ID',
      firstPersonalAttempts: 0,
      totalPersonalAttempts: 1,
    },
    {
      failureMode: 'personal card delivery',
      expectedError: '陈奇: 飞书单人消息临时失败',
      firstPersonalAttempts: 1,
      totalPersonalAttempts: 2,
    },
  ] as const)(
    'persists the 09:30 group delivery after $failureMode failure and retries only the personal notice',
    async ({
      failureMode,
      expectedError,
      firstPersonalAttempts,
      totalPersonalAttempts,
    }) => {
      const stateDir = mkdtempSync(
        join(tmpdir(), 'attendance-group-resilience-'),
      );
      process.env.ATTENDANCE_AUTOMATION_STATE_DIR = stateDir;
      process.env.PUBLIC_BASE_URL = 'https://sm.example.com';
      const run = {
        task: 'morning-off-duty-check' as const,
        date: '2026-09-15',
        scheduledAt: new Date('2026-09-15T01:30:00.000Z'),
      };
      const dingTalkClient = {
        listCorrectionApprovals: jest.fn().mockResolvedValue([]),
        listAllUsers: jest
          .fn()
          .mockResolvedValue([{ userId: 'ding-chen', name: '陈奇' }]),
        listAttendanceDetails: jest.fn().mockResolvedValue([]),
      };
      const dutyScheduleService = {
        getDutySchedules: jest.fn().mockResolvedValue([
          {
            recordId: 'current-white-chen',
            scheduleDate: run.date,
            building: 'building_c',
            team: 'team_1',
            shift: 'white',
            dutyStaffReference: ['陈奇'],
            dutyStaffActual: ['陈奇'],
            leaveStaff: [],
            substituteStaff: [],
          },
        ]),
        getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
      };
      const personalRecipient = { openId: 'ou_chen', name: '陈奇' };
      const resolvePersonalRecipients =
        failureMode === 'recipient resolution'
          ? jest
              .fn()
              .mockRejectedValueOnce(new Error('陈奇未匹配到唯一 Open ID'))
              .mockResolvedValueOnce([personalRecipient])
          : jest.fn().mockResolvedValue([personalRecipient]);
      const sendCard =
        failureMode === 'personal card delivery'
          ? jest
              .fn()
              .mockRejectedValueOnce(new Error('飞书单人消息临时失败'))
              .mockResolvedValueOnce('om_personal_chen')
          : jest.fn().mockResolvedValue('om_personal_chen');
      const attendanceGateway = {
        readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
        readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
        archiveAttendance: jest
          .fn()
          .mockResolvedValue({ total: 1, created: 1, updated: 0 }),
        resolvePersonalRecipients,
        sendCard,
        readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
          archiveRecordCount: 64,
          businessDate: '2026-09-14',
          fetchedAt: '2026-09-15 09:30',
          anomalies: [],
          normal: [],
          normalByBuilding: {},
          checkedTasks: [],
        }),
      };
      const dailySummaryStore = { mergeLiveCheck: jest.fn() };
      const patrolService = {
        isEnabled: jest.fn().mockReturnValue(true),
        collectReport: jest.fn().mockResolvedValue({
          businessDate: run.date,
          startDate: run.date,
          endDate: '2026-09-22',
          generatedAt: '2026-09-15T01:30:00.000Z',
          evaluatedFacilityPoints: 7,
          checks: [],
          totalIssues: 0,
          hasAlerts: false,
        }),
        prepareMorningFollowUps: jest.fn().mockResolvedValue({
          recordIds: ['follow-up-chen'],
          followUpCardId: '0123456789abcdef0123456789abcdef',
        }),
        sendMorningBriefCard: jest.fn().mockResolvedValue('om_group'),
      };

      try {
        const first = new AttendanceAutomationCoordinatorService(
          dingTalkClient as unknown as DingTalkAttendanceClient,
          dutyScheduleService as unknown as DutyScheduleService,
          attendanceGateway as unknown as AttendanceAutomationFeishuGateway,
          dailySummaryStore as unknown as AttendanceDailySummaryStore,
          patrolService as unknown as DailyOperationsPatrolService,
        );

        await expect(first.run(run)).rejects.toThrow(expectedError);
        expect(patrolService.sendMorningBriefCard).toHaveBeenCalledTimes(1);
        expect(attendanceGateway.sendCard).toHaveBeenCalledTimes(
          firstPersonalAttempts,
        );
        expect(first.getRunStatus(run.task, run.date)).toMatchObject({
          state: 'failed',
          failureReason: '个人考勤异常卡片发送失败',
        });
        const failedState = JSON.parse(
          readFileSync(
            join(stateDir, 'attendance-automation-task-state.json'),
            'utf8',
          ),
        );
        expect(failedState.completed).toHaveProperty(
          '2026-09-15:morning-brief:group:v6-group-card-resilience',
        );

        const restarted = new AttendanceAutomationCoordinatorService(
          dingTalkClient as unknown as DingTalkAttendanceClient,
          dutyScheduleService as unknown as DutyScheduleService,
          attendanceGateway as unknown as AttendanceAutomationFeishuGateway,
          dailySummaryStore as unknown as AttendanceDailySummaryStore,
          patrolService as unknown as DailyOperationsPatrolService,
        );
        await expect(restarted.run(run)).resolves.toMatchObject({
          success: true,
          managementSummary: { sent: 0 },
        });

        expect(
          attendanceGateway.resolvePersonalRecipients,
        ).toHaveBeenCalledTimes(2);
        expect(attendanceGateway.sendCard).toHaveBeenCalledTimes(
          totalPersonalAttempts,
        );
        expect(attendanceGateway.sendCard).toHaveBeenCalledWith(
          'ou_chen',
          expect.any(Object),
          expect.any(String),
        );
        expect(patrolService.sendMorningBriefCard).toHaveBeenCalledTimes(1);
        expect(patrolService.sendMorningBriefCard).toHaveBeenCalledWith(
          expect.any(Object),
          run.date,
          'unified-full-v4',
          '0123456789abcdef0123456789abcdef',
        );
        if (totalPersonalAttempts === 2) {
          expect(attendanceGateway.sendCard.mock.calls[0][2]).toBe(
            attendanceGateway.sendCard.mock.calls[1][2],
          );
        }
        expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
        expect(restarted.getRunStatus(run.task, run.date)).toMatchObject({
          state: 'completed',
          completedAt: expect.any(String),
        });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it('retries only the failed personal recipient after another recipient was delivered', async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), 'attendance-personal-delivery-ledger-'),
    );
    process.env.ATTENDANCE_AUTOMATION_STATE_DIR = stateDir;
    process.env.PUBLIC_BASE_URL = 'https://sm.example.com';
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-16',
      scheduledAt: new Date('2026-09-16T01:30:00.000Z'),
    };
    const dingTalkClient = {
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
      listAllUsers: jest.fn().mockResolvedValue([
        { userId: 'ding-li', name: '李董' },
        { userId: 'ding-mei', name: '梅冰冰' },
      ]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'current-white-li-mei',
          scheduleDate: run.date,
          building: 'building_a',
          team: 'team_1',
          shift: 'white',
          dutyStaffReference: ['李董', '梅冰冰'],
          dutyStaffActual: ['李董', '梅冰冰'],
          leaveStaff: [],
          substituteStaff: [],
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const sendAttempts = new Map<string, number>();
    const sendCard = jest.fn(async (openId: string) => {
      const attempt = (sendAttempts.get(openId) || 0) + 1;
      sendAttempts.set(openId, attempt);
      if (openId === 'ou_li') {
        if (attempt > 1) throw new Error('duplicate uuid');
        return 'om_personal_li';
      }
      if (attempt === 1) throw new Error('temporary delivery failure');
      return 'om_personal_mei';
    });
    const attendanceGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockResolvedValue({ total: 2, created: 2, updated: 0 }),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([
        { openId: 'ou_li', name: '李董' },
        { openId: 'ou_mei', name: '梅冰冰' },
      ]),
      sendCard,
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        archiveRecordCount: 64,
        businessDate: '2026-09-15',
        fetchedAt: '2026-09-16 09:30',
        anomalies: [],
        normal: [],
        normalByBuilding: {},
        checkedTasks: [],
      }),
    };
    const dailySummaryStore = { mergeLiveCheck: jest.fn() };
    const patrolService = {
      isEnabled: jest.fn().mockReturnValue(true),
      collectReport: jest.fn().mockResolvedValue({
        businessDate: run.date,
        startDate: run.date,
        endDate: '2026-09-23',
        generatedAt: '2026-09-16T01:30:00.000Z',
        evaluatedFacilityPoints: 7,
        checks: [],
        totalIssues: 0,
        hasAlerts: false,
      }),
      prepareMorningFollowUps: jest.fn().mockResolvedValue({
        recordIds: ['follow-up-li', 'follow-up-mei'],
        followUpUrl:
          'https://sm.example.com/attendance-anomaly-follow-up?ticket=signed.ticket',
      }),
      sendMorningBriefCard: jest.fn().mockResolvedValue('om_group'),
    };

    try {
      const first = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        attendanceGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
        patrolService as unknown as DailyOperationsPatrolService,
      );
      await expect(first.run(run)).rejects.toThrow(
        'temporary delivery failure',
      );

      const restarted = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        attendanceGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
        patrolService as unknown as DailyOperationsPatrolService,
      );
      await expect(restarted.run(run)).resolves.toMatchObject({
        success: true,
        managementSummary: { sent: 0 },
      });

      expect(sendAttempts.get('ou_li')).toBe(1);
      expect(sendAttempts.get('ou_mei')).toBe(2);
      expect(patrolService.sendMorningBriefCard).toHaveBeenCalledTimes(1);
      expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('keeps the 18:35 attendance result recoverable when personal recipients cannot be read', async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), 'attendance-evening-personal-recovery-'),
    );
    process.env.ATTENDANCE_AUTOMATION_STATE_DIR = stateDir;
    process.env.ATTENDANCE_AUTOMATION_RETRY_DELAY_MS = '1000';
    process.env.PUBLIC_BASE_URL = 'https://sm.example.com';
    const run = {
      task: 'evening-off-duty-check' as const,
      date: '2026-09-15',
      scheduledAt: new Date('2026-09-15T10:35:00.000Z'),
    };
    const dingTalkClient = {
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'ding-chen', name: '陈奇' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([
        {
          recordId: 'current-white-chen',
          scheduleDate: run.date,
          building: 'building_c',
          team: 'team_1',
          shift: 'white',
          dutyStaffReference: ['陈奇'],
          dutyStaffActual: ['陈奇'],
          leaveStaff: [],
          substituteStaff: [],
        },
      ]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const attendanceGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockResolvedValue({ total: 1, created: 1, updated: 0 }),
      resolvePersonalRecipientsBestEffort: jest.fn().mockResolvedValue({
        recipients: [],
        failures: ['个人组织关系暂时不可用'],
      }),
      resolvePersonalRecipients: jest.fn(),
      sendCard: jest.fn(),
    };
    const dailySummaryStore = { mergeLiveCheck: jest.fn() };

    try {
      const service = new AttendanceAutomationCoordinatorService(
        dingTalkClient as unknown as DingTalkAttendanceClient,
        dutyScheduleService as unknown as DutyScheduleService,
        attendanceGateway as unknown as AttendanceAutomationFeishuGateway,
        dailySummaryStore as unknown as AttendanceDailySummaryStore,
      );

      await expect(service.run(run)).rejects.toThrow(
        '个人考勤异常卡片发送失败',
      );
      expect(dailySummaryStore.mergeLiveCheck).toHaveBeenCalledTimes(1);
      expect(service.getRunStatus(run.task, run.date)).toMatchObject({
        state: 'failed',
        failureReason: '个人考勤异常卡片发送失败',
        failureScope: 'personal-delivery',
        attemptCount: 1,
        maxAttempts: 6,
        finalFailure: false,
        nextRetryAt: expect.any(String),
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
