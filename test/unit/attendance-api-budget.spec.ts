import type { HttpService } from '@nestjs/axios';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttendanceAutomationCoordinatorService } from '../../server/modules/duty-schedule/attendance-automation-coordinator.service';
import { getNextAttendanceAutomationRun } from '../../server/modules/duty-schedule/attendance-automation.scheduler';
import { DingTalkAttendanceClient } from '../../server/modules/duty-schedule/dingtalk-attendance.client';

const buildSchedule = (overrides: Record<string, unknown> = {}) => ({
  id: 'schedule-1',
  recordId: 'schedule-1',
  dutyCode: 'schedule-1',
  scheduleDate: '2026-09-03',
  code: null,
  building: 'building_c',
  team: 'team_1',
  shift: 'white',
  personText: '值班人员1',
  dutyStaffReference: ['值班人员1'],
  dutyStaffActual: ['值班人员1'],
  remark: '',
  emergencyDuty: '',
  emergencyDutySchedule: '',
  leaveStaff: [],
  substituteStaff: [],
  actualDutyStaff: '值班人员1',
  buildingText: 'C楼',
  teamText: '一班',
  shiftText: '白班',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const buildUnifiedPatrol = () => ({
  isEnabled: jest.fn(() => false),
  sendMorningBriefCard: jest.fn().mockResolvedValue('om_group'),
});

describe('DingTalk attendance daily API budget', () => {
  const originalEnv = process.env;
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'attendance-budget-'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_STATE_DIR: stateDir,
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
      PUBLIC_BASE_URL: 'https://ops.example.com',
      CLIENT_BASE_PATH: '/platform',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(stateDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('only schedules 00:30, 08:55, 09:30, 17:55 and 18:35 in Shanghai', () => {
    const cases = [
      [
        '2026-09-02T16:29:59.000Z',
        'archive-yesterday',
        '2026-09-02T16:30:00.000Z',
      ],
      [
        '2026-09-02T16:30:00.000Z',
        'morning-on-duty-reminder',
        '2026-09-03T00:55:00.000Z',
      ],
      [
        '2026-09-03T00:55:00.000Z',
        'morning-off-duty-check',
        '2026-09-03T01:30:00.000Z',
      ],
      [
        '2026-09-03T01:30:00.000Z',
        'evening-on-duty-reminder',
        '2026-09-03T09:55:00.000Z',
      ],
      [
        '2026-09-03T09:55:00.000Z',
        'evening-off-duty-check',
        '2026-09-03T10:35:00.000Z',
      ],
      [
        '2026-09-03T10:35:00.000Z',
        'archive-yesterday',
        '2026-09-03T16:30:00.000Z',
      ],
    ] as const;

    for (const [now, task, scheduledAt] of cases) {
      expect(getNextAttendanceAutomationRun(new Date(now))).toMatchObject({
        task,
        scheduledAt: new Date(scheduledAt),
      });
    }
  });

  it('queries 94 users through listRecord in exactly two non-paginated batches', async () => {
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/attendance/listRecord')) {
        return { data: { errcode: 0, recordresult: [] } };
      }
      if (url.endsWith('/attendance/list')) {
        return { data: { errcode: 0, recordresult: [], hasMore: false } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await client.listAttendanceDetails({
      start: '2026-09-03 00:00:00',
      end: '2026-09-03 08:55:59',
      userIds: Array.from({ length: 94 }, (_, index) => `u${index + 1}`),
    });

    const calls = post.mock.calls.filter(([url]) =>
      url.includes('/attendance/listRecord'),
    );
    expect(calls).toHaveLength(2);
    expect(
      calls.map(([, body]) => (body as { userIds: string[] }).userIds.length),
    ).toEqual([50, 44]);
    expect(
      post.mock.calls.some(([url]) => url.endsWith('/attendance/list')),
    ).toBe(false);
  });

  it('keeps a complete 94-person day at twelve attendance calls plus five correction discoveries', async () => {
    const users = Array.from({ length: 94 }, (_, index) => ({
      userid: `u${index + 1}`,
      name: `值班人员${index + 1}`,
    }));
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/department/listsub')) {
        return { data: { errcode: 0, result: [] } };
      }
      if (url.includes('/user/list')) {
        return {
          data: {
            errcode: 0,
            result: { list: users, has_more: false },
          },
        };
      }
      if (url.includes('/attendance/listRecord')) {
        return { data: { errcode: 0, recordresult: [] } };
      }
      if (url.endsWith('/attendance/list')) {
        return { data: { errcode: 0, recordresult: [], hasMore: false } };
      }
      if (url.includes('/topapi/processinstance/listids')) {
        return { data: { errcode: 0, result: { list: [] } } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);
    const schedules = [
      buildSchedule({
        id: 'schedule-previous-night',
        recordId: 'schedule-previous-night',
        scheduleDate: '2026-09-01',
        shift: 'night',
        shiftText: '夜班',
        personText: '值班人员1',
        dutyStaffReference: ['值班人员1'],
        dutyStaffActual: ['值班人员1'],
        actualDutyStaff: '值班人员1',
      }),
      buildSchedule({
        id: 'schedule-yesterday-white',
        recordId: 'schedule-yesterday-white',
        scheduleDate: '2026-09-02',
        personText: '值班人员2',
        dutyStaffReference: ['值班人员2'],
        dutyStaffActual: ['值班人员2'],
        actualDutyStaff: '值班人员2',
      }),
      buildSchedule({
        id: 'schedule-yesterday-night',
        recordId: 'schedule-yesterday-night',
        scheduleDate: '2026-09-02',
        shift: 'night',
        shiftText: '夜班',
        personText: '值班人员3',
        dutyStaffReference: ['值班人员3'],
        dutyStaffActual: ['值班人员3'],
        actualDutyStaff: '值班人员3',
      }),
      buildSchedule({
        id: 'schedule-today-white',
        recordId: 'schedule-today-white',
        scheduleDate: '2026-09-03',
        personText: '值班人员4',
        dutyStaffReference: ['值班人员4'],
        dutyStaffActual: ['值班人员4'],
        actualDutyStaff: '值班人员4',
      }),
      buildSchedule({
        id: 'schedule-today-night',
        recordId: 'schedule-today-night',
        scheduleDate: '2026-09-03',
        shift: 'night',
        shiftText: '夜班',
        personText: '值班人员5',
        dutyStaffReference: ['值班人员5'],
        dutyStaffActual: ['值班人员5'],
        actualDutyStaff: '值班人员5',
      }),
    ];
    const dutyScheduleService = {
      getDutySchedules: jest.fn((start: string) =>
        Promise.resolve(start === '2026-08-30' ? [] : schedules),
      ),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest
        .fn()
        .mockResolvedValue({ total: 0, created: 0, updated: 0 }),
      readArchivedAttendanceCoverage: jest.fn().mockResolvedValue({}),
      readArchivedAttendanceRecheckTargets: jest.fn().mockResolvedValue([]),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-02',
        fetchedAt: '2026-09-03 00:31',
        anomalies: [],
        normal: [],
        normalByBuilding: { H楼: 1 },
        checkedTasks: [],
      }),
      resolveRecipients: jest
        .fn()
        .mockResolvedValue([
          { openId: 'ou_manager', name: '机房经理', scope: 'manager' },
        ]),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
      sendCard: jest.fn().mockResolvedValue('om_message'),
    };
    const dailySummaryStore = {
      write: jest.fn().mockResolvedValue(undefined),
      mergeLiveCheck: jest.fn().mockResolvedValue(undefined),
    };
    const patrol = buildUnifiedPatrol();
    const service = new AttendanceAutomationCoordinatorService(
      client,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
      patrol as any,
    );

    await service.run({
      task: 'archive-yesterday',
      date: '2026-09-02',
      scheduledAt: new Date('2026-09-02T16:30:00.000Z'),
    });
    for (const [task, scheduledAt] of [
      ['morning-on-duty-reminder', '2026-09-03T00:55:00.000Z'],
      ['morning-off-duty-check', '2026-09-03T01:30:00.000Z'],
      ['evening-on-duty-reminder', '2026-09-03T09:55:00.000Z'],
      ['evening-off-duty-check', '2026-09-03T10:35:00.000Z'],
    ] as const) {
      await service.run({
        task,
        date: '2026-09-03',
        scheduledAt: new Date(scheduledAt),
      });
    }

    expect(
      post.mock.calls.filter(([url]) => url.includes('/attendance/listRecord')),
    ).toHaveLength(10);
    expect(
      post.mock.calls.filter(([url]) => url.endsWith('/attendance/list')),
    ).toHaveLength(2);
    expect(
      post.mock.calls.filter(
        ([url]) =>
          url.includes('/attendance/listRecord') ||
          url.endsWith('/attendance/list'),
      ),
    ).toHaveLength(12);
    expect(
      post.mock.calls.filter(([url]) => url.includes('/department/listsub')),
    ).toHaveLength(1);
    expect(
      post.mock.calls.filter(([url]) => url.includes('/user/list')),
    ).toHaveLength(1);
    expect(
      post.mock.calls.filter(([url]) =>
        url.includes('/topapi/processinstance/listids'),
      ),
    ).toHaveLength(5);
    expect(feishuGateway.readArchivedAttendanceSummary).toHaveBeenCalledTimes(
      2,
    );
    expect(
      feishuGateway.readArchivedAttendanceRecheckTargets,
    ).toHaveBeenCalledWith(['2026-09-01', '2026-08-31']);
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(1);
  });

  it('uses one 09:30 DingTalk snapshot for the personal card without an organization card', async () => {
    const users = Array.from({ length: 94 }, (_, index) => ({
      userId: `u${index + 1}`,
      name: `值班人员${index + 1}`,
    }));
    const dingTalkClient = {
      listAllUsers: jest.fn().mockResolvedValue(users),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
      listAttendanceResults: jest.fn(() => {
        throw new Error('attendance/list must not be called');
      }),
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([buildSchedule()]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest.fn().mockResolvedValue({
        total: 1,
        created: 1,
        updated: 0,
      }),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-02',
        fetchedAt: '2026-09-03 00:31',
        anomalies: [],
        normal: [],
        normalByBuilding: {},
        checkedTasks: [],
      }),
      resolveRecipients: jest.fn().mockResolvedValue([]),
      resolvePersonalRecipients: jest
        .fn()
        .mockResolvedValue([{ openId: 'ou_staff', name: '值班人员1' }]),
      sendCard: jest.fn().mockResolvedValue('om_message'),
    };
    const dailySummaryStore = {
      mergeLiveCheck: jest.fn().mockResolvedValue(undefined),
    };
    const patrol = buildUnifiedPatrol();
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
      patrol as any,
    );

    await service.run({
      task: 'morning-off-duty-check',
      date: '2026-09-03',
      scheduledAt: new Date('2026-09-03T01:30:00.000Z'),
    });

    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledWith({
      start: '2026-09-03 00:00:00',
      end: '2026-09-03 09:30:59',
      userIds: users.map((user) => user.userId),
    });
    expect(dingTalkClient.listAttendanceResults).not.toHaveBeenCalled();
    expect(dingTalkClient.listCorrectionApprovals).toHaveBeenCalledTimes(1);
    expect(feishuGateway.sendCard).toHaveBeenCalledTimes(1);
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(1);
  });

  it('reuses the persisted DingTalk snapshot when Feishu delivery is retried', async () => {
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockResolvedValue([{ userId: 'u1', name: '值班人员1' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
      listAttendanceResults: jest.fn(),
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([buildSchedule()]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest.fn().mockResolvedValue({
        total: 1,
        created: 1,
        updated: 0,
      }),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-02',
        fetchedAt: '2026-09-03 00:31',
        anomalies: [],
        normal: [],
        normalByBuilding: {},
        checkedTasks: [],
      }),
      resolveRecipients: jest.fn().mockResolvedValue([]),
      resolvePersonalRecipients: jest
        .fn()
        .mockResolvedValue([{ openId: 'ou_staff', name: '值班人员1' }]),
      sendCard: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary Feishu failure'))
        .mockResolvedValueOnce('om_message'),
    };
    const dailySummaryStore = {
      mergeLiveCheck: jest.fn().mockResolvedValue(undefined),
    };
    const patrol = buildUnifiedPatrol();
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
      patrol as any,
    );
    const run = {
      task: 'morning-off-duty-check' as const,
      date: '2026-09-03',
      scheduledAt: new Date('2026-09-03T01:30:00.000Z'),
    };

    await expect(service.run(run)).rejects.toThrow('temporary Feishu failure');
    await expect(service.run(run)).resolves.toMatchObject({ success: true });

    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(1);
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
    expect(patrol.sendMorningBriefCard).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(patrol.sendMorningBriefCard.mock.calls[0][0]),
    ).toContain('考勤异常 1 项');
    expect(
      JSON.stringify(patrol.sendMorningBriefCard.mock.calls[0][0]),
    ).not.toContain('考勤待核验');
  });

  it('releases the task claim when DingTalk capture fails before a snapshot exists', async () => {
    const dingTalkClient = {
      listAllUsers: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary DingTalk failure'))
        .mockResolvedValueOnce([{ userId: 'u1', name: '值班人员1' }]),
      listAttendanceDetails: jest.fn().mockResolvedValue([]),
      listAttendanceResults: jest.fn(),
      listCorrectionApprovals: jest.fn().mockResolvedValue([]),
    };
    const dutyScheduleService = {
      getDutySchedules: jest.fn().mockResolvedValue([buildSchedule()]),
      getLongWhiteDutyStaff: jest.fn().mockResolvedValue({ buildings: [] }),
    };
    const feishuGateway = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readAttendanceOvertimeRecords: jest.fn().mockResolvedValue([]),
      archiveAttendance: jest.fn().mockResolvedValue({
        total: 1,
        created: 1,
        updated: 0,
      }),
      resolvePersonalRecipients: jest.fn().mockResolvedValue([]),
      sendCard: jest.fn(),
    };
    const dailySummaryStore = {
      mergeLiveCheck: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AttendanceAutomationCoordinatorService(
      dingTalkClient as any,
      dutyScheduleService as any,
      feishuGateway as any,
      dailySummaryStore as any,
    );
    const run = {
      task: 'evening-off-duty-check' as const,
      date: '2026-09-03',
      scheduledAt: new Date('2026-09-03T10:35:00.000Z'),
    };

    await expect(service.run(run)).rejects.toThrow(
      'temporary DingTalk failure',
    );
    await expect(service.run(run)).resolves.toMatchObject({ success: true });

    expect(dingTalkClient.listAllUsers).toHaveBeenCalledTimes(2);
    expect(dingTalkClient.listAttendanceDetails).toHaveBeenCalledTimes(1);
    expect(feishuGateway.archiveAttendance).toHaveBeenCalledTimes(1);
  });
});
