import { TodayAttendanceSnapshotService } from '../../server/modules/duty-schedule/today-attendance-snapshot.service';

describe('TodayAttendanceSnapshotService', () => {
  const now = new Date('2026-09-05T02:00:00.000Z');
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(now); });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('preserves same-phase verified results when the leave refresh fails', async () => {
    const archive = {
      readApprovedAttendanceLeave: jest.fn().mockResolvedValue([]),
      readApprovedAttendanceLeaveForDisplay: jest.fn().mockResolvedValueOnce([]).mockRejectedValue(new Error('approval timeout')),
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05', fetchedAt: '2026-09-05 09:30',
        normalByBuilding: { H楼: 1 },
        anomalies: [{ key: 'fixture', name: '测试甲', building: 'H楼', shiftLabel: '白班', direction: 'OnDuty', expectedAt: '2026-09-05 09:00:00', reason: '未打卡' }],
      }),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);
    const first = await service.getSnapshot(now);
    await jest.advanceTimersByTimeAsync(16_000);
    const second = await service.getSnapshot(new Date(now.getTime() + 16_000));
    expect(second).toMatchObject({ sourceStatus: 'stale', summary: first.summary, entries: first.entries });
    expect(archive.readApprovedAttendanceLeaveForDisplay).toHaveBeenCalledTimes(2);
    expect(archive.readApprovedAttendanceLeave).not.toHaveBeenCalled();
  });

  it('removes a newly approved leave punch from an older local anomaly summary', async () => {
    const leave = {
      recordId: 'leave-1',
      building: 'D栋',
      leaveStaff: ['彭怀响'],
      substituteStaff: [],
      startAt: '2026-09-05 08:00:00',
      endAt: '2026-09-05 18:00:00',
    };
    const archive = {
      readApprovedAttendanceLeaveForDisplay: jest.fn().mockResolvedValue([leave]),
      readArchivedAttendanceSummary: jest.fn(),
    };
    const summaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-09-05',
        generatedAt: '2026-09-05T01:31:00.000Z',
        source: 'dingtalk-archive',
        expected: 1,
        normal: 0,
        excluded: 0,
        anomalies: [],
        checks: {
          'morning-off-duty-check': {
            generatedAt: '2026-09-05T01:31:00.000Z',
            expectedKeys: ['d-on'],
            normalKeys: [],
            excludedKeys: [],
            anomalies: [{
              key: 'd-on', name: '彭怀响', building: 'D楼',
              shiftLabel: '白班', direction: 'OnDuty',
              expectedAt: '2026-09-05 09:00:00', status: 'on_duty', reason: '未打卡',
            }],
          },
        },
      }),
    };
    const service = new TodayAttendanceSnapshotService(archive as any, summaryStore as any);

    await expect(service.getSnapshot(now)).resolves.toMatchObject({
      summary: { expected: 0, normal: 0, anomaly: 0, excluded: 1 },
      entries: [],
    });
    expect(archive.readApprovedAttendanceLeaveForDisplay).toHaveBeenCalledTimes(1);
  });

  it('shows the previous calendar day final anomalies before 09:30 Shanghai time', async () => {
    const beforeMorningFinal = new Date('2026-09-06T01:29:59.999Z');
    const archive = { readArchivedAttendanceSummary: jest.fn() };
    const summaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-09-05',
        generatedAt: '2026-09-05T10:35:10.000Z',
        source: 'dingtalk-archive',
        expected: 2,
        normal: 1,
        excluded: 0,
        anomalies: [],
        checks: {
          'morning-off-duty-check': {
            generatedAt: '2026-09-05T01:30:10.000Z',
            expectedKeys: ['morning-normal'],
            normalKeys: ['morning-normal'],
            excludedKeys: [],
            anomalies: [],
          },
          'evening-off-duty-check': {
            generatedAt: '2026-09-05T10:35:10.000Z',
            expectedKeys: ['evening-anomaly'],
            normalKeys: [],
            excludedKeys: [],
            anomalies: [
              {
                key: 'evening-anomaly',
                name: '昨日异常人员',
                building: 'H楼',
                shiftLabel: '白班',
                direction: 'OffDuty',
                expectedAt: '2026-09-05 18:00:00',
                status: 'off_duty',
                reason: '未打卡',
              },
            ],
          },
        },
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      summaryStore as any,
    );

    await expect(
      service.getSnapshot(beforeMorningFinal),
    ).resolves.toMatchObject({
      date: '2026-09-05',
      displayScope: 'previous-day',
      sourceStatus: 'fresh',
      checkedTasks: ['morning-off-duty-check', 'evening-off-duty-check'],
      summary: { expected: 2, normal: 1, anomaly: 1 },
      entries: [expect.objectContaining({ name: '昨日异常人员' })],
    });
    expect(summaryStore.read).toHaveBeenCalledWith('2026-09-05');
    expect(archive.readArchivedAttendanceSummary).not.toHaveBeenCalled();
  });

  it('shows the completed local archive after it replaces the live checks', async () => {
    const archive = { readArchivedAttendanceSummary: jest.fn() };
    const summaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-09-05',
        generatedAt: '2026-09-05T16:31:00.000Z',
        source: 'dingtalk-archive',
        expected: 2,
        normal: 1,
        excluded: 0,
        anomalies: [
          {
            key: 'yesterday-missing',
            name: '测试甲',
            building: 'H楼',
            shiftLabel: '白班',
            direction: 'OffDuty',
            expectedAt: '2026-09-05 18:00:00',
            status: 'on_duty',
            reason: '未打卡',
          },
        ],
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      summaryStore as any,
    );

    await expect(
      service.getSnapshot(new Date('2026-09-06T00:11:00.000Z')),
    ).resolves.toMatchObject({
      date: '2026-09-05',
      displayScope: 'previous-day',
      sourceStatus: 'fresh',
      fetchedAt: '2026-09-06 00:31',
      summary: { expected: 2, normal: 1, anomaly: 1, excluded: 0 },
      entries: [expect.objectContaining({ key: 'yesterday-missing' })],
    });
    expect(archive.readArchivedAttendanceSummary).not.toHaveBeenCalled();
  });

  it('keeps yesterday punch results visible while archived correction approvals are pending', async () => {
    const archive = { readArchivedAttendanceSummary: jest.fn() };
    const summaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-09-05',
        generatedAt: '2026-09-05T16:31:00.000Z',
        source: 'dingtalk-archive',
        expected: 2,
        normal: 1,
        excluded: 0,
        anomalies: [
          {
            key: 'yesterday-missing',
            name: '测试员',
            building: 'H楼',
            shiftLabel: '白班',
            direction: 'OffDuty',
            expectedAt: '2026-09-05 18:00:00',
            status: 'off_duty',
            reason: '未打卡',
          },
        ],
      }),
    };
    const coordinator = {
      getRunStatus: jest.fn().mockReturnValue({
        state: 'completed',
        task: 'archive-yesterday',
        date: '2026-09-05',
        scheduledAt: '2026-09-05T16:30:00.000Z',
        lastAttemptAt: '2026-09-05T16:31:00.000Z',
        completedAt: '2026-09-05T16:31:00.000Z',
        correctionSyncFailureReason: '钉钉补卡审批查询失败',
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      summaryStore as any,
      coordinator as any,
    );

    await expect(
      service.getSnapshot(new Date('2026-09-06T00:11:00.000Z')),
    ).resolves.toMatchObject({
      date: '2026-09-05',
      displayScope: 'previous-day',
      sourceStatus: 'fresh',
      runStatus: {
        state: 'completed',
        scheduledAt: '2026-09-06 00:30',
        correctionSyncFailureReason: '钉钉补卡审批查询失败',
      },
      summary: { expected: 2, normal: 1, anomaly: 1 },
      entries: [expect.objectContaining({ key: 'yesterday-missing' })],
    });
    expect(coordinator.getRunStatus).toHaveBeenCalledWith(
      'archive-yesterday',
      '2026-09-05',
    );
  });

  it('accepts an archived final result even when a morning reminder remains', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05',
        fetchedAt: '2026-09-06 00:31',
        hasArchivedResult: true,
        checkedTasks: ['morning-on-duty-reminder'],
        normalByBuilding: { H楼: 2 },
        anomalies: [],
      }),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);

    await expect(
      service.getSnapshot(new Date('2026-09-06T00:11:00.000Z')),
    ).resolves.toMatchObject({
      displayScope: 'previous-day',
      sourceStatus: 'fresh',
      summary: { expected: 2, normal: 2, anomaly: 0 },
    });
  });

  it('does not treat a morning reminder alone as yesterday final attendance', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05',
        fetchedAt: '2026-09-05 08:55',
        hasArchivedResult: false,
        checkedTasks: ['morning-on-duty-reminder'],
        normalByBuilding: { H楼: 2 },
        anomalies: [],
      }),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);

    await expect(
      service.getSnapshot(new Date('2026-09-06T00:11:00.000Z')),
    ).resolves.toMatchObject({
      displayScope: 'previous-day',
      sourceStatus: 'stale',
      summary: { expected: 0, normal: 0, anomaly: 0 },
    });
  });

  it('never returns waiting after 09:30 when only the archive fallback is available', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest
        .fn()
        .mockResolvedValue({ normalByBuilding: {}, anomalies: [] }),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);
    await expect(service.getSnapshot(now)).resolves.toMatchObject({
      sourceStatus: 'not-run',
    });
  });

  it('does not reuse a previous-day fallback after the 09:30 boundary', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest
        .fn()
        .mockRejectedValue(new Error('offline')),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);
    await expect(
      service.getSnapshot(new Date('2026-09-05T01:29:59Z')),
    ).resolves.toMatchObject({
      date: '2026-09-04',
      displayScope: 'previous-day',
      sourceStatus: 'stale',
    });
    await expect(service.getSnapshot(now)).rejects.toThrow(
      '今日考勤数据暂不可用，请稍后重试',
    );
  });

  it('does not share a pre-09:30 in-flight response with the final phase', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-04',
        fetchedAt: '2026-09-04 18:35',
        checkedTasks: ['morning-off-duty-check', 'evening-off-duty-check'],
        normalByBuilding: { H楼: 1 },
        anomalies: [],
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      undefined,
      { getRunStatus: jest.fn().mockReturnValue(null) } as any,
    );
    const waiting = service.getSnapshot(new Date('2026-09-05T01:29:59.000Z'));
    const due = service.getSnapshot(new Date('2026-09-05T01:30:00.000Z'));
    await expect(waiting).resolves.toMatchObject({
      date: '2026-09-04',
      displayScope: 'previous-day',
      sourceStatus: 'fresh',
    });
    await expect(due).resolves.toMatchObject({ sourceStatus: 'not-run' });
  });

  it('returns an explicit previous-day unavailable state when yesterday has no result', async () => {
    const beforeFirstCheck = new Date('2026-09-06T00:11:00.000Z');
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05',
        fetchedAt: '2026-09-05 18:35',
        checkedTasks: ['morning-off-duty-check', 'evening-off-duty-check'],
        anomalies: [],
        normalByBuilding: {},
      }),
    };
    const summaryStore = {
      read: jest.fn().mockResolvedValue(null),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      summaryStore as any,
    );

    await expect(service.getSnapshot(beforeFirstCheck)).resolves.toMatchObject({
      date: '2026-09-05',
      displayScope: 'previous-day',
      sourceStatus: 'stale',
      checkedTasks: [],
      summary: { expected: 0, normal: 0, anomaly: 0, excluded: 0 },
      entries: [],
    });
  });

  it('does not read current-day preliminary reminders before the 09:30 final check', async () => {
    const beforeMorningFinal = new Date('2026-09-06T01:20:00.000Z');
    const archive = {
      readArchivedAttendanceSummary: jest.fn(),
    };
    const summaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-09-05',
        generatedAt: '2026-09-05T10:35:10.000Z',
        source: 'dingtalk-archive',
        expected: 1,
        normal: 0,
        excluded: 0,
        anomalies: [
          {
            key: 'previous-final',
            name: '昨日异常人员',
            building: 'H楼',
            shiftLabel: '白班',
            direction: 'OnDuty',
            expectedAt: '2026-09-05 18:00:00',
            status: 'off_duty',
            reason: '未打卡',
          },
        ],
        checks: {
          'evening-off-duty-check': {
            generatedAt: '2026-09-05T10:35:10.000Z',
            expectedKeys: ['previous-final'],
            normalKeys: [],
            excludedKeys: [],
            anomalies: [
              {
                key: 'previous-final',
                name: '昨日异常人员',
                building: 'H楼',
                shiftLabel: '白班',
                direction: 'OffDuty',
                expectedAt: '2026-09-05 18:00:00',
                status: 'off_duty',
                reason: '未打卡',
              },
            ],
          },
        },
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      summaryStore as any,
    );

    await expect(
      service.getSnapshot(beforeMorningFinal),
    ).resolves.toMatchObject({
      date: '2026-09-05',
      displayScope: 'previous-day',
      sourceStatus: 'fresh',
      entries: [expect.objectContaining({ name: '昨日异常人员' })],
      summary: { expected: 1, normal: 0, anomaly: 1 },
    });
    expect(archive.readArchivedAttendanceSummary).not.toHaveBeenCalled();
  });

  it('switches from the previous day to today exactly at 09:30', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05',
        fetchedAt: '2026-09-05 18:35',
        checkedTasks: ['morning-off-duty-check', 'evening-off-duty-check'],
        normalByBuilding: { H楼: 1 },
        anomalies: [],
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      undefined,
      { getRunStatus: jest.fn().mockReturnValue(null) } as any,
    );

    await expect(
      service.getSnapshot(new Date('2026-09-06T01:29:59.500Z')),
    ).resolves.toMatchObject({
      date: '2026-09-05',
      displayScope: 'previous-day',
      sourceStatus: 'fresh',
    });
    await expect(
      service.getSnapshot(new Date('2026-09-06T01:30:00.000Z')),
    ).resolves.toMatchObject({ sourceStatus: 'not-run' });
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledTimes(1);
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledWith(
      '2026-09-05',
    );
  });

  it('shows only the 09:30 and 18:35 final-check anomalies', async () => {
    const afterEveningFinal = new Date('2026-09-06T10:40:00.000Z');
    const archive = {
      readArchivedAttendanceSummary: jest.fn(),
    };
    const anomaly = (
      key: string,
      name: string,
      direction: 'OnDuty' | 'OffDuty',
    ) => ({
      key,
      name,
      building: 'H楼',
      shiftLabel: '白班',
      direction,
      expectedAt: `2026-09-06 ${direction === 'OnDuty' ? '09:00:00' : '18:00:00'}`,
      status: 'on_duty' as const,
      reason: '未打卡',
    });
    const summaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-09-06',
        generatedAt: '2026-09-06T10:35:10.000Z',
        source: 'dingtalk-archive',
        expected: 3,
        normal: 0,
        excluded: 0,
        anomalies: [
          anomaly('preliminary', '预提醒人员', 'OnDuty'),
          anomaly('morning-final', '早间异常', 'OnDuty'),
          anomaly('evening-final', '晚间异常', 'OffDuty'),
        ],
        checks: {
          'morning-on-duty-reminder': {
            generatedAt: '2026-09-06T00:55:10.000Z',
            expectedKeys: ['preliminary'],
            normalKeys: [],
            excludedKeys: [],
            anomalies: [anomaly('preliminary', '预提醒人员', 'OnDuty')],
          },
          'morning-off-duty-check': {
            generatedAt: '2026-09-06T01:30:10.000Z',
            expectedKeys: ['morning-final'],
            normalKeys: [],
            excludedKeys: [],
            anomalies: [anomaly('morning-final', '早间异常', 'OnDuty')],
          },
          'evening-off-duty-check': {
            generatedAt: '2026-09-06T10:35:10.000Z',
            expectedKeys: ['evening-final'],
            normalKeys: [],
            excludedKeys: [],
            anomalies: [anomaly('evening-final', '晚间异常', 'OffDuty')],
          },
        },
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      summaryStore as any,
    );

    const snapshot = await service.getSnapshot(afterEveningFinal);

    expect(snapshot.checkedTasks).toEqual([
      'morning-off-duty-check',
      'evening-off-duty-check',
    ]);
    expect(snapshot.entries.map((entry) => entry.name)).toEqual([
      '早间异常',
      '晚间异常',
    ]);
    expect(snapshot.summary).toMatchObject({ expected: 2, anomaly: 2 });
    expect(archive.readArchivedAttendanceSummary).not.toHaveBeenCalled();
  });

  it('reads today attendance only from the Feishu archive', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05',
        fetchedAt: '2026-09-05 09:05',
        anomalies: [
          {
            key: '2026-09-05:building_h:night:OnDuty:支佳伟',
            name: '支佳伟',
            building: 'H楼',
            shiftLabel: '夜班',
            direction: 'OnDuty',
            expectedAt: '2026-09-05 09:00:00',
            status: 'on_duty',
            reason: '迟到 8 分钟',
          },
        ],
        normalByBuilding: { H楼: 3, C楼: 2 },
      }),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);

    await expect(service.getSnapshot(now)).resolves.toMatchObject({
      date: '2026-09-05',
      fetchedAt: '2026-09-05 09:05',
      sourceStatus: 'fresh',
      summary: { expected: 6, normal: 5, anomaly: 1 },
      entries: [
        expect.objectContaining({
          name: '支佳伟',
          building: 'H楼',
          status: 'anomaly',
          reason: '迟到 8 分钟',
        }),
      ],
    });
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledWith(
      '2026-09-05',
    );
  });

  it('serves the scheduled 09:30 final summary before reading Feishu again', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest
        .fn()
        .mockRejectedValue(new Error('Feishu unavailable')),
    };
    const summaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-09-05',
        generatedAt: '2026-09-05T01:30:10.000Z',
        source: 'dingtalk-archive',
        expected: 2,
        normal: 1,
        excluded: 0,
        anomalies: [
          {
            key: '2026-09-05:building_h:white:OnDuty:支佳伟',
            name: '支佳伟',
            building: 'H楼',
            shiftLabel: '白班',
            direction: 'OnDuty',
            expectedAt: '2026-09-05 09:00:00',
            status: 'on_duty',
            reason: '迟到',
          },
        ],
        checks: {
          'morning-off-duty-check': {
            generatedAt: '2026-09-05T01:30:10.000Z',
            expectedKeys: [
              '2026-09-05:building_h:white:OnDuty:支佳伟',
              '2026-09-05:building_h:white:OnDuty:正常人员',
            ],
            normalKeys: ['2026-09-05:building_h:white:OnDuty:正常人员'],
            excludedKeys: [],
            anomalies: [
              {
                key: '2026-09-05:building_h:white:OnDuty:支佳伟',
                name: '支佳伟',
                building: 'H楼',
                shiftLabel: '白班',
                direction: 'OnDuty',
                expectedAt: '2026-09-05 09:00:00',
                status: 'on_duty',
                reason: '迟到',
              },
            ],
          },
        },
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      summaryStore as any,
      {
        getRunStatus: jest.fn().mockReturnValue({
          state: 'completed',
          task: 'morning-off-duty-check',
          date: '2026-09-05',
          scheduledAt: '2026-09-05T01:30:00.000Z',
          lastAttemptAt: '2026-09-05T01:30:01.000Z',
          completedAt: '2026-09-05T01:30:10.000Z',
          correctionSyncFailureReason: '钉钉补卡审批查询失败',
        }),
      } as any,
    );

    await expect(service.getSnapshot(now)).resolves.toMatchObject({
      date: '2026-09-05',
      fetchedAt: '2026-09-05 09:30',
      sourceStatus: 'fresh',
      runStatus: {
        state: 'completed',
        correctionSyncFailureReason: '钉钉补卡审批查询失败',
      },
      summary: { expected: 2, normal: 1, anomaly: 1, excluded: 0 },
      entries: [
        expect.objectContaining({
          building: 'H楼',
          name: '支佳伟',
          reason: '迟到',
        }),
      ],
    });
    expect(summaryStore.read).toHaveBeenCalledWith('2026-09-05');
    expect(archive.readArchivedAttendanceSummary).not.toHaveBeenCalled();
  });

  it('reuses the short archive cache and never owns a DingTalk dependency', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05',
        fetchedAt: '2026-09-05 09:05',
        anomalies: [],
        normalByBuilding: { H楼: 2 },
      }),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);

    const first = await service.getSnapshot(now);
    const cached = await service.getSnapshot(new Date(now.getTime() + 5_000));
    const refreshed = await service.getSnapshot(
      new Date(now.getTime() + 5_001),
      true,
    );

    expect(cached).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledTimes(2);
  });

  it('lets a forced refresh bypass an older in-flight snapshot and keeps the newer result cached', async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveFresh!: (value: unknown) => void;
    const oldRequest = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const freshRequest = new Promise((resolve) => {
      resolveFresh = resolve;
    });
    const archive = {
      readArchivedAttendanceSummary: jest
        .fn()
        .mockReturnValueOnce(oldRequest)
        .mockReturnValueOnce(freshRequest),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);

    const staleSnapshotRequest = service.getSnapshot(now);
    const forcedSnapshotRequest = service.getSnapshot(now, true);

    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledTimes(2);
    resolveFresh({
      businessDate: '2026-09-05',
      fetchedAt: '2026-09-05 09:31',
      checkedTasks: ['morning-off-duty-check'],
      anomalies: [],
      normalByBuilding: { H楼: 2 },
    });
    const forcedSnapshot = await forcedSnapshotRequest;
    resolveOld({
      businessDate: '2026-09-05',
      fetchedAt: '2026-09-05 09:30',
      checkedTasks: ['morning-off-duty-check'],
      anomalies: [],
      normalByBuilding: { H楼: 1 },
    });
    await staleSnapshotRequest;

    await expect(
      service.getSnapshot(new Date(now.getTime() + 1_000)),
    ).resolves.toBe(forcedSnapshot);
    expect(forcedSnapshot).toMatchObject({
      fetchedAt: '2026-09-05 09:31',
      summary: { normal: 2 },
    });
  });

  it('reports a missing 09:30 run as not-run instead of waiting forever', async () => {
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({
        businessDate: '2026-09-05',
        fetchedAt: '2026-09-05 00:30',
        anomalies: [],
        normalByBuilding: {},
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      undefined,
      { getRunStatus: jest.fn().mockReturnValue(null) } as any,
    );

    await expect(service.getSnapshot(now)).resolves.toMatchObject({
      sourceStatus: 'not-run',
      runStatus: {
        state: 'not-run',
        scheduledAt: '2026-09-05 09:30',
      },
      summary: { expected: 0, normal: 0, anomaly: 0, excluded: 0 },
      entries: [],
    });
    expect(archive.readArchivedAttendanceSummary).not.toHaveBeenCalled();
  });

  it.each(['running', 'failed'] as const)(
    'exposes a persisted %s 09:30 run instead of reporting pending',
    async (state) => {
      const archive = { readArchivedAttendanceSummary: jest.fn() };
      const service = new TodayAttendanceSnapshotService(
        archive as any,
        undefined,
        {
          getRunStatus: jest.fn().mockReturnValue({
            state,
            task: 'morning-off-duty-check',
            date: '2026-09-05',
            scheduledAt: '2026-09-05T01:30:00.000Z',
            lastAttemptAt: '2026-09-05T01:31:00.000Z',
          }),
        } as any,
      );

      await expect(service.getSnapshot(now)).resolves.toMatchObject({
        sourceStatus: state,
        runStatus: {
          state,
          scheduledAt: '2026-09-05 09:30',
          lastAttemptAt: '2026-09-05 09:31',
        },
      });
      expect(archive.readArchivedAttendanceSummary).not.toHaveBeenCalled();
    },
  );

  it('exposes retry timing, attempt count and the safe failure reason', async () => {
    const archive = { readArchivedAttendanceSummary: jest.fn() };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      undefined,
      {
        getRunStatus: jest.fn().mockReturnValue({
          state: 'failed',
          task: 'morning-off-duty-check',
          date: '2026-09-05',
          scheduledAt: '2026-09-05T01:30:00.000Z',
          firstAttemptAt: '2026-09-05T01:31:00.000Z',
          lastAttemptAt: '2026-09-05T01:36:00.000Z',
          failedAt: '2026-09-05T01:36:20.000Z',
          attemptCount: 2,
          maxAttempts: 6,
          failureReason: '个人异常接收人读取失败',
          nextRetryAt: '2026-09-05T01:41:20.000Z',
          retryCutoffAt: '2026-09-05T02:01:00.000Z',
          finalFailure: false,
        }),
      } as any,
    );

    await expect(service.getSnapshot(now)).resolves.toMatchObject({
      sourceStatus: 'failed',
      runStatus: {
        state: 'failed',
        scheduledAt: '2026-09-05 09:30',
        firstAttemptAt: '2026-09-05 09:31',
        lastAttemptAt: '2026-09-05 09:36',
        attemptCount: 2,
        maxAttempts: 6,
        failureReason: '个人异常接收人读取失败',
        failureScope: 'personal-delivery',
        nextRetryAt: '2026-09-05 09:41',
        retryCutoffAt: '2026-09-05 10:01',
        finalFailure: false,
      },
    });
  });

  it('keeps a partial attendance result visible while the full 09:30 run is failed', async () => {
    const archive = { readArchivedAttendanceSummary: jest.fn() };
    const summaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-09-05',
        generatedAt: '2026-09-05T01:30:10.000Z',
        source: 'dingtalk-archive',
        expected: 1,
        normal: 0,
        excluded: 0,
        anomalies: [],
        checks: {
          'morning-off-duty-check': {
            generatedAt: '2026-09-05T01:30:10.000Z',
            expectedKeys: ['normal-person'],
            normalKeys: ['normal-person'],
            excludedKeys: [],
            anomalies: [],
          },
        },
      }),
    };
    const service = new TodayAttendanceSnapshotService(
      archive as any,
      summaryStore as any,
      {
        getRunStatus: jest.fn().mockReturnValue({
          state: 'failed',
          task: 'morning-off-duty-check',
          date: '2026-09-05',
          scheduledAt: '2026-09-05T01:30:00.000Z',
          lastAttemptAt: '2026-09-05T01:31:00.000Z',
        }),
      } as any,
    );

    await expect(service.getSnapshot(now)).resolves.toMatchObject({
      sourceStatus: 'failed',
      fetchedAt: '2026-09-05 09:30',
      summary: { expected: 1, normal: 1, anomaly: 0 },
    });
  });

  const archivedResult = (normal = 2, businessDate = '2026-09-05') => ({
    businessDate, fetchedAt: `${businessDate} 09:30`, checkedTasks: ['morning-off-duty-check'],
    normalByBuilding: { H楼: normal }, anomalies: [],
  });
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
  };

  it.each([20_000, 45_000])('waits for a verified %ims approval read and gives the finished result a full cache TTL', async delay => {
    const approval = deferred<any[]>();
    const archive = {
      readArchivedAttendanceSummary: jest.fn().mockResolvedValue({ ...archivedResult(1), anomalies: [{
        key: 'leave-overlap', name: '测试甲', building: 'H楼', shiftLabel: '白班',
        direction: 'OnDuty', expectedAt: '2026-09-05 09:00:00', status: 'on_duty', reason: '未打卡',
      }] }),
      readApprovedAttendanceLeaveForDisplay: jest.fn().mockReturnValueOnce(approval.promise).mockResolvedValue([]),
    };
    const service = new TodayAttendanceSnapshotService(archive as any);
    let settled = false;
    const pending = service.getSnapshot(now).then(value => { settled = true; return value; });
    await jest.advanceTimersByTimeAsync(delay);
    expect(settled).toBe(false);
    approval.resolve([{ recordId: 'verified-leave', building: 'H楼', leaveStaff: ['测试甲'], substituteStaff: [], startAt: '2026-09-05 08:00:00', endAt: '2026-09-05 18:00:00' }]);
    const result = await pending;
    expect(result).toMatchObject({ sourceStatus: 'fresh', entries: [], summary: { expected: 1, anomaly: 0, excluded: 1 } });
    await jest.advanceTimersByTimeAsync(14_999);
    await expect(service.getSnapshot(new Date())).resolves.toBe(result);
    expect(archive.readApprovedAttendanceLeaveForDisplay).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await service.getSnapshot(new Date());
    expect(archive.readApprovedAttendanceLeaveForDisplay).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('expires only the first waiter at 50 seconds while a later waiter shares the same source and receives its late result', async () => {
    const source = deferred<any>();
    const archive = { readArchivedAttendanceSummary: jest.fn().mockReturnValue(source.promise) };
    const service = new TodayAttendanceSnapshotService(archive as any);
    const first = service.getSnapshot(now).then(value => ({ value }), error => ({ error }));
    await jest.advanceTimersByTimeAsync(20_000);
    let secondSettled = false;
    const second = service.getSnapshot(new Date()).then(value => { secondSettled = true; return value; });
    await jest.advanceTimersByTimeAsync(30_000);
    const firstResult = await first;
    expect('error' in firstResult && firstResult.error.getStatus()).toBe(503);
    expect(secondSettled).toBe(false);
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    source.resolve(archivedResult());
    const late = await second;
    expect(late.sourceStatus).toBe('fresh');
    await expect(service.getSnapshot(new Date())).resolves.toBe(late);
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns only an explicitly stale same-phase verified cache at the wait limit without caching that fallback', async () => {
    const source = deferred<any>();
    const archive = { readArchivedAttendanceSummary: jest.fn().mockResolvedValueOnce(archivedResult(2)).mockReturnValueOnce(source.promise) };
    const service = new TodayAttendanceSnapshotService(archive as any);
    const seed = await service.getSnapshot(now);
    const cachedAt = (service as any).cache.cachedAt;
    await jest.advanceTimersByTimeAsync(16_000);
    const refresh = service.getSnapshot(new Date(), true);
    await jest.advanceTimersByTimeAsync(50_000);
    await expect(refresh).resolves.toMatchObject({ sourceStatus: 'stale', summary: seed.summary, fetchedAt: seed.fetchedAt });
    expect((service as any).cache.cachedAt).toBe(cachedAt);
    expect((service as any).cache.snapshot).toBe(seed);
    const observing = service.getSnapshot(new Date());
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledTimes(2);
    source.resolve(archivedResult(3));
    const latest = await observing;
    expect(latest).toMatchObject({ sourceStatus: 'fresh', summary: { normal: 3 } });
    await expect(service.getSnapshot(new Date())).resolves.toBe(latest);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not treat an unavailable empty cache as a verified timeout fallback', async () => {
    const source = deferred<any>();
    const archive = { readArchivedAttendanceSummary: jest.fn().mockResolvedValueOnce(archivedResult(0)).mockReturnValueOnce(source.promise) };
    const service = new TodayAttendanceSnapshotService(archive as any);
    expect((await service.getSnapshot(now)).sourceStatus).toBe('not-run');
    const pending = service.getSnapshot(now, true).catch(error => error);
    await jest.advanceTimersByTimeAsync(50_000);
    expect((await pending).getStatus()).toBe(503);
    source.resolve(archivedResult(1));
    await jest.advanceTimersByTimeAsync(0);
    await expect(service.getSnapshot(new Date())).resolves.toMatchObject({ sourceStatus: 'fresh' });
  });

  it('lets force bypass an ordinary read but joins the latest forced generation without launching a third source read', async () => {
    const old = deferred<any>(), newer = deferred<any>();
    const archive = { readArchivedAttendanceSummary: jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise) };
    const service = new TodayAttendanceSnapshotService(archive as any);
    const ordinary = service.getSnapshot(now), forced = service.getSnapshot(now, true), joined = service.getSnapshot(now, true);
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledTimes(2);
    newer.resolve(archivedResult(3));
    const result = await forced;
    await expect(joined).resolves.toBe(result);
    old.resolve(archivedResult(1)); await ordinary;
    await expect(service.getSnapshot(now)).resolves.toBe(result);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not let an older phase finish late and replace the newer phase cache', async () => {
    const old = deferred<any>(), newer = deferred<any>();
    const archive = { readArchivedAttendanceSummary: jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise) };
    const service = new TodayAttendanceSnapshotService(archive as any);
    const previousDay = service.getSnapshot(new Date('2026-09-05T01:29:59Z'));
    const currentDay = service.getSnapshot(new Date('2026-09-05T01:30:00Z'));
    newer.resolve(archivedResult(3)); const result = await currentDay;
    old.resolve(archivedResult(1, '2026-09-04')); await previousDay;
    await expect(service.getSnapshot(new Date('2026-09-05T01:30:01Z'))).resolves.toBe(result);
    expect(archive.readArchivedAttendanceSummary).toHaveBeenCalledTimes(2);
  });

  it('rejects a timeout rather than reusing verified data from the previous phase', async () => {
    const source = deferred<any>();
    const archive = { readArchivedAttendanceSummary: jest.fn().mockResolvedValueOnce(archivedResult(2, '2026-09-04')).mockReturnValueOnce(source.promise) };
    const service = new TodayAttendanceSnapshotService(archive as any);
    await service.getSnapshot(new Date('2026-09-05T01:29:59Z'));
    const pending = service.getSnapshot(new Date('2026-09-05T01:30:00Z')).catch(error => error);
    await jest.advanceTimersByTimeAsync(50_000);
    expect((await pending).getStatus()).toBe(503);
    source.resolve(archivedResult(2)); await jest.advanceTimersByTimeAsync(0);
  });
});
