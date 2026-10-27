jest.mock('@server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('@server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
}));

import type { HttpService } from '@nestjs/axios';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
import { AttendanceAutomationFeishuGateway } from '../../server/modules/duty-schedule/attendance-automation-feishu.gateway';
import {
  DailyOperationsPatrolGateway,
  stableAttendancePeriodicSummaryMessageUuid,
} from '../../server/modules/duty-schedule/daily-operations-patrol.gateway';
import { AttendancePeriodicSummaryService } from '../../server/modules/duty-schedule/attendance-periodic-summary.service';
import type { AttendancePeriodicSummaryStore } from '../../server/modules/duty-schedule/attendance-periodic-summary.store';

describe('attendance periodic summary delivery', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
    jest.mocked(fetchBitableRecords).mockReset();
    jest.restoreAllMocks();
  });

  it('reads one date range from Bitable and keeps only each expectation latest effective result', async () => {
    const correctedKey = '2026-09-03:building_c:white:OnDuty:曹毅';
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      attendanceRecord({
        id: 'older-missing',
        workDate: '2026-09-03',
        key: correctedKey,
        name: '曹毅',
        buildingStatus: '未打卡',
        legal: '否',
        syncAt: '2026-09-03T16:31:00.000Z',
      }),
      attendanceRecord({
        id: 'newer-corrected',
        workDate: '2026-09-03',
        key: correctedKey,
        name: '曹毅',
        buildingStatus: '正常',
        legal: '是',
        syncAt: '2026-09-04T02:00:00.000Z',
      }),
      attendanceRecord({
        id: 'early',
        workDate: '2026-09-05',
        key: '2026-09-05:building_b:white:OffDuty:张三',
        name: '张三',
        buildingStatus: '早退',
        legal: '是',
        syncAt: '2026-09-05T16:31:00.000Z',
      }),
      attendanceRecord({
        id: 'outside',
        workDate: '2026-08-31',
        key: '2026-08-31:building_a:white:OnDuty:李四',
        name: '李四',
        buildingStatus: '迟到',
        legal: '是',
        syncAt: '2026-08-31T16:31:00.000Z',
      }),
    ] as never);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);

    const summary = await gateway.readArchivedAttendancePeriod(
      '2026-09-01',
      '2026-09-07',
    );

    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      checkedCount: 2,
      fetchedAt: '2026-09-06 00:31',
    });
    expect(summary.normal).toEqual([
      expect.objectContaining({ key: correctedKey, name: '曹毅' }),
    ]);
    expect(summary.anomalies).toEqual([
      expect.objectContaining({
        name: '张三',
        building: 'B楼',
        reason: '早退',
      }),
    ]);
  });

  it('queries Bitable, persists an outbox entry and sends one group card without personal delivery', async () => {
    const fixture = serviceFixture();
    const followUpService = {
      issueFollowUpUrl: jest.fn(
        () =>
          'https://sm.example.com/attendance-anomaly-follow-up?ticket=abc.DEF',
      ),
    };
    const service = new AttendancePeriodicSummaryService(
      fixture.attendanceGateway as never,
      fixture.groupGateway as never,
      fixture.store as unknown as AttendancePeriodicSummaryStore,
      followUpService as never,
    );
    const run = {
      period: 'weekly' as const,
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      scheduledAt: new Date('2026-09-08T02:00:00.000Z'),
    };

    const result = await service.run(run);

    expect(result).toMatchObject({ sent: true, skipped: false });
    expect(
      fixture.attendanceGateway.readArchivedAttendancePeriod,
    ).toHaveBeenCalledWith('2026-09-01', '2026-09-07');
    expect(
      fixture.groupGateway.sendAttendancePeriodicSummaryCard,
    ).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(
        fixture.groupGateway.sendAttendancePeriodicSummaryCard.mock.calls[0][0],
      ),
    ).toContain('迟到 1');
    expect(followUpService.issueFollowUpUrl).toHaveBeenCalledWith({
      from: '2026-09-01',
      through: '2026-09-07',
    });
    expect(
      JSON.stringify(
        fixture.groupGateway.sendAttendancePeriodicSummaryCard.mock.calls[0][0],
      ),
    ).toContain('异常跟进');
    expect(fixture.store.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.store.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.groupGateway.sendAttendancePeriodicSummaryCard.mock
        .invocationCallOrder[0],
    );
    expect(fixture.store.markSent).toHaveBeenCalledWith(
      'weekly:2026-09-01:2026-09-07',
      'om_weekly',
    );
  });

  it('skips a period already marked sent before querying Bitable', async () => {
    const fixture = serviceFixture();
    fixture.store.isSent.mockResolvedValueOnce(true);
    const service = new AttendancePeriodicSummaryService(
      fixture.attendanceGateway as never,
      fixture.groupGateway as never,
      fixture.store as unknown as AttendancePeriodicSummaryStore,
    );

    await expect(
      service.run({
        period: 'monthly',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        scheduledAt: new Date('2026-09-01T02:00:00.000Z'),
      }),
    ).resolves.toEqual({ sent: false, skipped: true });
    expect(
      fixture.attendanceGateway.readArchivedAttendancePeriod,
    ).not.toHaveBeenCalled();
    expect(
      fixture.groupGateway.sendAttendancePeriodicSummaryCard,
    ).not.toHaveBeenCalled();
  });

  it('uses separate stable UUID namespaces for weekly and monthly group cards', async () => {
    process.env.FEISHU_APP_ID = 'cli_test_app';
    process.env.FEISHU_APP_SECRET = 'test_secret';
    process.env.NANTONG_DAILY_PATROL_CHAT_ID = 'oc_test_group';
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-test', expire: 7200 },
      })
      .mockResolvedValue({
        data: { code: 0, data: { message_id: 'om_periodic' } },
      });
    const gateway = new DailyOperationsPatrolGateway({
      axiosRef: { post },
    } as unknown as HttpService);
    const weekly = {
      period: 'weekly' as const,
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      scheduledAt: new Date('2026-09-08T02:00:00.000Z'),
    };
    const monthly = {
      period: 'monthly' as const,
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      scheduledAt: new Date('2026-09-08T02:00:00.000Z'),
    };

    await gateway.sendAttendancePeriodicSummaryCard({ schema: '2.0' }, weekly);
    await gateway.sendAttendancePeriodicSummaryCard({ schema: '2.0' }, monthly);

    const weeklyUuid = stableAttendancePeriodicSummaryMessageUuid(
      weekly,
      'oc_test_group',
    );
    const monthlyUuid = stableAttendancePeriodicSummaryMessageUuid(
      monthly,
      'oc_test_group',
    );
    expect(weeklyUuid).toMatch(/^aps_[a-f0-9]{40}$/u);
    expect(monthlyUuid).not.toBe(weeklyUuid);
    expect(post.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        receive_id: 'oc_test_group',
        uuid: weeklyUuid,
      }),
    );
    expect(post.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        receive_id: 'oc_test_group',
        uuid: monthlyUuid,
      }),
    );
  });
});

function attendanceRecord(input: {
  id: string;
  workDate: string;
  key: string;
  name: string;
  buildingStatus: string;
  legal: string;
  syncAt: string;
}) {
  const [, , , , direction] = input.key.split(':');
  return {
    record_id: input.id,
    fields: {
      记录类型: '考勤结果',
      姓名: input.name,
      工作日期: Date.parse(`${input.workDate}T00:00:00+08:00`),
      打卡类型: direction === 'OffDuty' ? '下班' : '上班',
      应打卡时间: Date.parse(`${input.workDate}T09:00:00+08:00`),
      时间状态: input.buildingStatus,
      是否合法: input.legal,
      原始记录JSON: JSON.stringify({ expectationKey: input.key }),
      同步时间: Date.parse(input.syncAt),
    },
  };
}

function serviceFixture() {
  return {
    attendanceGateway: {
      readArchivedAttendancePeriod: jest.fn().mockResolvedValue({
        startDate: '2026-09-01',
        endDate: '2026-09-07',
        fetchedAt: '2026-09-08 10:00',
        checkedCount: 12,
        normal: [],
        anomalies: [
          {
            key: 'late',
            name: '张三',
            building: 'C楼',
            shiftLabel: '白班',
            direction: 'OnDuty',
            expectedAt: '2026-09-03 09:00:00',
            status: 'on_duty',
            reason: '迟到',
          },
        ],
      }),
    },
    groupGateway: {
      sendAttendancePeriodicSummaryCard: jest
        .fn()
        .mockResolvedValue('om_weekly'),
    },
    store: {
      isSent: jest.fn().mockResolvedValue(false),
      prepare: jest.fn().mockResolvedValue(undefined),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    },
  };
}
