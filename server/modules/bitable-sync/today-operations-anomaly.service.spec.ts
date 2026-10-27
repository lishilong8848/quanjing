import { TodayOperationsAnomalyService as ActualTodayOperationsAnomalyService } from './today-operations-anomaly.service';
import { withSyntheticBusinessIdentity } from '../../../test/unit/synthetic-business-identity.fixture';
const TodayOperationsAnomalyService = withSyntheticBusinessIdentity(ActualTodayOperationsAnomalyService, 8);
type TodayOperationsAnomalyService = ActualTodayOperationsAnomalyService;

describe('TodayOperationsAnomalyService card actions', () => {
  it('provisions patrol and attendance follow-ups before issuing one scoped URL', async () => {
    const gateway = {
      ensureFollowUpEvent: jest
        .fn()
        .mockResolvedValueOnce('recPatrol')
        .mockResolvedValueOnce('recAttendance'),
    };
    const tickets = {
      issueUrl: jest.fn(
        () => 'https://sm.example.com/attendance-anomaly-follow-up?ticket=x.y',
      ),
    };
    const service = new TodayOperationsAnomalyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      gateway as never,
      undefined,
      undefined,
      tickets as never,
    );

    const result = await service.syncMorningFollowUps({
      detectedAt: '2026-09-09T01:35:00.000Z',
      patrol: {
        businessDate: '2026-09-09',
        startDate: '2026-09-09',
        endDate: '2026-09-16',
        generatedAt: '2026-09-09T01:30:00.000Z',
        evaluatedFacilityPoints: 100,
        totalIssues: 1,
        hasAlerts: true,
        checks: [
          {
            key: 'schedule',
            label: '排班连班风险',
            status: 'alert',
            count: 1,
            summary: '1项',
            issues: [
              {
                id: 'risk-1',
                check: 'schedule',
                title: '连班风险',
                detail: 'H楼夜班后接白班',
                date: '2026-09-09',
                severity: 'warning',
              },
            ],
          },
        ],
      },
      sections: [
        {
          title: '昨日白班',
          date: '2026-09-08',
          normalCount: 0,
          anomalies: [
            {
              key: 'attendance-1',
              name: '张文豪',
              building: 'C楼',
              shiftLabel: '白班',
              direction: 'OffDuty',
              expectedAt: '2026-09-08 18:00:00',
              status: 'on_duty',
              reason: '未打卡',
            },
          ],
        },
      ],
    });

    expect(gateway.ensureFollowUpEvent).toHaveBeenCalledTimes(2);
    expect(tickets.issueUrl).toHaveBeenCalledWith({
      from: '2026-09-08',
      through: '2026-09-09',
    });
    expect(result.recordIds).toEqual(['recPatrol', 'recAttendance']);
  });

  it('does not create empty follow-up records or issue a URL on a normal day', async () => {
    const gateway = { ensureFollowUpEvent: jest.fn() };
    const tickets = { issueUrl: jest.fn() };
    const service = new TodayOperationsAnomalyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      gateway as never,
      undefined,
      undefined,
      tickets as never,
    );
    await expect(
      service.syncMorningFollowUps({
        patrol: null,
        sections: [],
        detectedAt: '2026-09-09T01:35:00.000Z',
      }),
    ).resolves.toEqual({ recordIds: [], followUpUrl: '' });
    expect(gateway.ensureFollowUpEvent).not.toHaveBeenCalled();
    expect(tickets.issueUrl).not.toHaveBeenCalled();
  });

  it('still issues a follow-up URL for a normal daily patrol card', async () => {
    const gateway = { ensureFollowUpEvent: jest.fn() };
    const tickets = {
      issueUrl: jest.fn(
        () => 'https://sm.example.com/attendance-anomaly-follow-up?ticket=x.y',
      ),
    };
    const service = new TodayOperationsAnomalyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      gateway as never,
      undefined,
      undefined,
      tickets as never,
    );
    const patrol = {
      businessDate: '2026-09-09',
      startDate: '2026-09-09',
      endDate: '2026-09-16',
      generatedAt: '2026-09-09T01:30:00.000Z',
      evaluatedFacilityPoints: 100,
      totalIssues: 0,
      hasAlerts: false,
      checks: [],
    };

    await expect(
      service.syncMorningFollowUps({
        patrol,
        sections: [],
        detectedAt: patrol.generatedAt,
      }),
    ).resolves.toEqual({
      recordIds: [],
      followUpUrl:
        'https://sm.example.com/attendance-anomaly-follow-up?ticket=x.y',
    });
    expect(gateway.ensureFollowUpEvent).not.toHaveBeenCalled();
    expect(tickets.issueUrl).toHaveBeenCalledWith({
      from: '2026-09-09',
      through: '2026-09-09',
    });
  });

  it('rejects an update when the record date is outside the signed range', async () => {
    const gateway = {
      getFollowUp: jest.fn().mockResolvedValue({ date: '2026-09-01' }),
      updateFollowUp: jest.fn(),
    };
    const service = new TodayOperationsAnomalyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      gateway as never,
    );
    await expect(
      service.updateFollowUp(
        {
          recordId: 'recFollowUp01',
          acknowledged: true,
          completed: false,
          treatmentMeasure: '',
          clientMutationId: 'mutation-follow-up-0001',
        },
        { from: '2026-09-08', through: '2026-09-09' },
      ),
    ).rejects.toThrow('不在当前授权范围');
    expect(gateway.updateFollowUp).not.toHaveBeenCalled();
  });

  it('shows the treatment form without claiming a terminal state', async () => {
    const { service, store } = createService();
    const card = await service.renderCardView({
      anomalyEventId: 'e'.repeat(64),
      recordId: 'recAnomaly1',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      messageId: 'om_message1',
      view: 'resolution',
    });

    expect(JSON.stringify(card)).toContain(
      'today_operations_treatment_measure',
    );
    expect(store.claimTerminal).not.toHaveBeenCalled();
  });

  it('claims resolved immediately and schedules durable background sync', async () => {
    const { service, store } = createService();
    const claim = await service.acceptTerminalAction({
      anomalyEventId: 'e'.repeat(64),
      recordId: 'recAnomaly1',
      eventId: 'event-1',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      messageId: 'om_message1',
      terminal: 'resolved',
      treatmentMeasure: '完成检查并恢复采集',
    });

    expect(claim.claimed).toBe(true);
    expect(store.claimTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: 'resolved',
        treatmentMeasure: '完成检查并恢复采集',
      }),
    );
    expect(JSON.stringify(claim.card)).toContain('正在同步');
  });

  it('resolves a form submit by event and verified callback message', async () => {
    const { service, store } = createService();
    const claim = await service.acceptTerminalAction({
      anomalyEventId: 'e'.repeat(64),
      eventId: 'event-short-form',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      messageId: 'om_message1',
      terminal: 'resolved',
      treatmentMeasure: '已完成现场检查',
    });

    expect(claim.claimed).toBe(true);
    expect(store.claimTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        anomalyEventId: 'e'.repeat(64),
        recordId: undefined,
        messageId: 'om_message1',
      }),
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it('rejects a callback message that is not recorded for the anomaly', async () => {
    const { service, store } = createService();

    await expect(
      service.acceptTerminalAction({
        anomalyEventId: 'e'.repeat(64),
        eventId: 'event-wrong-message',
        actorOpenId: `ou_${'a'.repeat(20)}`,
        messageId: 'om_other_message',
        terminal: 'resolved',
        treatmentMeasure: '不应受理',
      }),
    ).rejects.toThrow('今日航图异常事件不存在');
    expect(store.claimTerminal).toHaveBeenCalledTimes(1);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('still opens the treatment form after acknowledgement', async () => {
    const { service, store, entry } = createService();
    store.get.mockResolvedValue({
      ...entry,
      terminal: 'acknowledged',
      terminalEventId: 'event-acknowledged',
      actorName: '知悉人',
      handledAt: '2026-08-20T01:00:00.000Z',
      syncStatus: 'completed',
    });

    const card = await service.renderCardView({
      anomalyEventId: 'e'.repeat(64),
      recordId: 'recAnomaly1',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      messageId: 'om_message1',
      view: 'resolution',
    });

    expect(JSON.stringify(card)).toContain(
      'today_operations_treatment_measure',
    );
  });

  it('merges the persisted 00:30 yesterday attendance result into the 08:30 event', async () => {
    const discovered: unknown[][] = [];
    const store = {
      discoverAll: jest.fn(async (anomalies: unknown[]) => {
        discovered.push(anomalies);
      }),
      listUnprovisioned: jest.fn().mockResolvedValue([]),
      listPendingSync: jest.fn().mockResolvedValue([]),
    };
    const attendanceSummaryStore = {
      read: jest.fn().mockResolvedValue({
        version: 1,
        businessDate: '2026-08-29',
        generatedAt: '2026-08-30T16:30:00.000Z',
        source: 'dingtalk-archive',
        expected: 2,
        normal: 1,
        excluded: 0,
        anomalies: [
          {
            key: '2026-08-29:building_c:white:OnDuty:顾晓磊',
            name: '顾晓磊',
            building: 'C楼',
            shiftLabel: '白班',
            direction: 'OnDuty',
            expectedAt: '2026-08-29 09:00:00',
            status: 'substitute',
            reason: '未打卡',
          },
        ],
      }),
    };
    const failingSource = {
      getKpisForAnomalyScan: jest.fn().mockRejectedValue(new Error('kpi down')),
      getOverview: jest.fn().mockRejectedValue(new Error('overview down')),
      getDashboard: jest.fn().mockRejectedValue(new Error('alarm down')),
    };
    const service = new (TodayOperationsAnomalyService as any)(
      failingSource,
      failingSource,
      failingSource,
      store,
      {},
      { scan: jest.fn().mockResolvedValue([]) },
      attendanceSummaryStore,
    ) as TodayOperationsAnomalyService;

    await service.runForBusinessDate('2026-08-30');

    expect(attendanceSummaryStore.read).toHaveBeenCalledWith('2026-08-29');
    expect(discovered.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricLabel: '昨日考勤异常',
          scope: 'C楼 · 顾晓磊',
          details: expect.arrayContaining([
            expect.stringContaining('替班人员'),
            expect.stringContaining('未打卡'),
          ]),
        }),
      ]),
    );
  });

  it('rechecks current schedule consistency and reconciles stale entries', async () => {
    const issue = {
      issueId: 'i'.repeat(64),
      kind: 'approved_substitute_missing' as const,
      sourceRecordId: 'recLeave',
      scheduleRecordId: 'recSchedule',
      scope: '2026-08-20 B栋 白班',
      location: '排班页面 > 2026-08-20 B栋 白班',
      dataDate: '2026-08-20',
      details: ['已审批替班人员未更新'],
    };
    const store = {
      discoverAll: jest.fn().mockResolvedValue({ created: false }),
      reconcileScheduleConsistency: jest.fn().mockResolvedValue({
        changed: true,
        autoResolved: false,
        entry: null,
      }),
    };
    const scheduleConsistencyService = {
      scan: jest.fn().mockResolvedValue([issue]),
    };
    const service = new TodayOperationsAnomalyService(
      {} as never,
      {} as never,
      {} as never,
      store as never,
      {} as never,
      scheduleConsistencyService as never,
    );

    const result =
      await service.reconcileScheduleConsistencyForBusinessDate('2026-08-20');

    expect(scheduleConsistencyService.scan).toHaveBeenCalledWith('2026-08-20');
    expect(store.discoverAll).toHaveBeenCalledWith([
      expect.objectContaining({
        businessDate: '2026-08-20',
        metricKey: expect.stringContaining(
          'scheduleConsistency.approved_substitute_missing',
        ),
      }),
    ]);
    expect(store.reconcileScheduleConsistency).toHaveBeenCalledWith(
      '2026-08-20',
      expect.any(Array),
    );
    expect(result).toEqual({ detected: 1, changed: true, autoResolved: false });
  });
});

function createService() {
  const anomaly = {
    anomalyId: 'a'.repeat(64),
    businessDate: '2026-08-20',
    category: 'increase' as const,
    metricKey: 'alarms.yesterdayTotal',
    metricLabel: '昨日告警总数',
    scope: '园区',
    location: '今日航图 > 告警',
    currentValue: 387,
    previousValue: 154,
    changePercent: 151.3,
    unit: '条',
    dataDate: '2026-08-19',
    comparisonDate: '2026-08-18',
    details: ['C楼 363条'],
    detectedAt: '2026-08-20T00:30:00.000Z',
  };
  const anomalyEvent = {
    anomalyEventId: 'e'.repeat(64),
    businessDate: anomaly.businessDate,
    anomalies: [anomaly],
    detectedAt: anomaly.detectedAt,
  };
  const entry = {
    anomalyEvent,
    recordId: 'recAnomaly1',
    messageIds: ['om_message1'],
    duplicateRecordIds: [],
    provisionStatus: 'completed',
    terminal: null,
    terminalEventId: '',
    actorOpenId: '',
    actorName: '',
    handledAt: '',
    treatmentMeasure: '',
    syncStatus: 'idle',
    syncAttempts: 0,
    nextAttemptAt: anomaly.detectedAt,
    lastError: '',
    createdAt: anomaly.detectedAt,
    updatedAt: anomaly.detectedAt,
  };
  const store = {
    get: jest.fn().mockResolvedValue(entry),
    claimTerminal: jest.fn().mockImplementation(async (input) => {
      if (!entry.messageIds.includes(input.messageId)) {
        throw new Error('今日航图异常事件不存在');
      }
      return {
        claimed: true,
        entry: {
          ...entry,
          terminal: 'resolved',
          treatmentMeasure: '完成检查并恢复采集',
          syncStatus: 'pending',
        },
      };
    }),
  };
  const gateway = {
    recipientOpenId: jest.fn(() => `ou_${'a'.repeat(20)}`),
    recipientName: jest.fn(() => '马进宇'),
    patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TodayOperationsAnomalyService(
    {} as never,
    {} as never,
    {} as never,
    store as never,
    gateway as never,
  );
  return { service, store, entry };
}
