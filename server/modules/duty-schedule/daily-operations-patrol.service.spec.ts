import type { BitableSyncService } from '../bitable-sync/bitable-sync.service';
import type { TodayOperationsKpiService } from '../bitable-sync/today-operations-kpi.service';
import type { DutyScheduleService } from './duty-schedule.service';
import type { DailyOperationsPatrolGateway } from './daily-operations-patrol.gateway';
import { DailyOperationsPatrolService } from './daily-operations-patrol.service';
import type { DailyOperationsPatrolStore } from './daily-operations-patrol.store';

describe('DailyOperationsPatrolService', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
    jest.restoreAllMocks();
  });

  it('collects all four checks and sends exactly one normal card', async () => {
    const fixture = createFixture();
    const service = createService(fixture);

    const result = await service.runForBusinessDate(
      '2026-09-07',
      new Date('2026-09-07T01:30:00.000Z'),
    );

    expect(result).toMatchObject({ sent: true, skipped: false });
    expect(fixture.gateway.sendCard).toHaveBeenCalledTimes(1);
    const card = fixture.gateway.sendCard.mock.calls[0][0];
    expect(JSON.stringify(card)).toContain('南通每日运维巡视同步 · 正常');
    expect(fixture.kpi.getKpisForAnomalyScan).toHaveBeenCalledWith('2026-09-07');
    expect(fixture.schedule.getMonthlySchedules).toHaveBeenCalledWith(
      2026,
      9,
      true,
    );
    expect(fixture.schedule.getYearlyChangeInfo).toHaveBeenCalledWith(
      2026,
      true,
    );
    expect(fixture.schedule.getYearlySealingInfo).toHaveBeenCalledWith(
      2026,
      true,
    );
    expect(fixture.bitable.getWeatherWarningFetchResult).toHaveBeenCalledWith(
      true,
    );
    expect(fixture.store.markSent).toHaveBeenCalledWith(
      '2026-09-07',
      'om_patrol',
    );
  });

  it('uses the canonical Nantong host for card navigation links', async () => {
    process.env.NANTONG_DAILY_PATROL_PUBLIC_BASE_URL =
      'https://www.sm.sjhl.online:3001/';
    const fixture = createFixture();
    const service = createService(fixture);

    await service.runForBusinessDate(
      '2026-09-07',
      new Date('2026-09-07T01:30:00.000Z'),
    );

    const card = JSON.stringify(fixture.gateway.sendCard.mock.calls[0][0]);
    expect(card).toContain(
      'https://sm.sjhl.online:3001/today-operations-panorama',
    );
    expect(card).toContain('https://sm.sjhl.online:3001/monthly-schedule');
    expect(card).not.toContain('https://www.sm.sjhl.online:3001');
  });

  it('does not evaluate data dated on the patrol day', async () => {
    const fixture = createFixture();
    const priorPeriods = [
      { date: '2026-09-06', rows: [{ building: 'A楼', value: 10 }] },
      { date: '2026-09-05', rows: [{ building: 'A楼', value: 10 }] },
      { date: '2026-09-04', rows: [{ building: 'A楼', value: 10 }] },
    ];
    const history = [
      { date: '2026-09-07', rows: [{ building: 'A楼', value: 100 }] },
      ...priorPeriods,
    ];
    fixture.kpi.getKpisForAnomalyScan.mockResolvedValueOnce({
      details: {
        buildingMetrics: {
          averagePue: { history },
          electricityKwh: { history },
          waterTons: { history },
        },
      },
    });
    const service = createService(fixture);

    const report = await service.collectReport(
      '2026-09-07',
      new Date('2026-09-07T01:30:00.000Z'),
    );

    expect(report.checks[0].status).toBe('normal');
  });

  it('shows the affected date and metric in the patrol card when source data is incomplete', async () => {
    const fixture = createFixture();
    const history = [
      { date: '2026-09-06', rows: [{ building: 'A楼', value: 10 }] },
      { date: '2026-09-05', rows: [{ building: 'A楼', value: 10 }] },
      { date: '2026-09-04', rows: [{ building: 'A楼', value: 10 }] },
    ];
    fixture.kpi.getKpisForAnomalyScan.mockResolvedValueOnce({
      details: {
        buildingMetrics: {
          averagePue: { history },
          electricityKwh: { history },
          waterTons: { history: history.slice(0, 1) },
        },
      },
    });
    const service = createService(fixture);

    await service.runForBusinessDate(
      '2026-09-07',
      new Date('2026-09-07T01:30:00.000Z'),
    );

    const card = JSON.stringify(fixture.gateway.sendCard.mock.calls[0][0]);
    expect(card).toContain('2026-09-05 水耗未取得完整有效日数据');
    expect(card).toContain('2026-09-04 水耗未取得完整有效日数据');
  });

  it('sends a single alert card when one source is unavailable', async () => {
    const fixture = createFixture();
    fixture.kpi.getKpisForAnomalyScan.mockRejectedValueOnce(
      new Error('KPI source unavailable'),
    );
    const service = createService(fixture);

    await service.runForBusinessDate(
      '2026-09-07',
      new Date('2026-09-07T01:30:00.000Z'),
    );

    expect(fixture.gateway.sendCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fixture.gateway.sendCard.mock.calls[0][0])).toContain(
      'KPI source unavailable',
    );
    expect(fixture.followUp.syncMorningFollowUps).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fixture.gateway.sendCard.mock.calls[0][0])).toContain(
      '异常跟进',
    );
    expect(
      fixture.followUp.syncMorningFollowUps.mock.invocationCallOrder[0],
    ).toBeLessThan(fixture.gateway.sendCard.mock.invocationCallOrder[0]);
  });

  it('skips a business date already marked as sent', async () => {
    const fixture = createFixture();
    fixture.store.isSent.mockResolvedValueOnce(true);
    const service = createService(fixture);

    const result = await service.runForBusinessDate('2026-09-07');

    expect(result).toEqual({ sent: false, skipped: true });
    expect(fixture.gateway.sendCard).not.toHaveBeenCalled();
    expect(fixture.kpi.getKpisForAnomalyScan).not.toHaveBeenCalled();
  });

  it('records a failed delivery after preparing the durable entry', async () => {
    const fixture = createFixture();
    fixture.gateway.sendCard.mockRejectedValueOnce(new Error('Feishu down'));
    const service = createService(fixture);

    await expect(service.runForBusinessDate('2026-09-07')).rejects.toThrow(
      'Feishu down',
    );

    expect(fixture.store.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.store.markFailed).toHaveBeenCalledWith(
      '2026-09-07',
      expect.objectContaining({ message: 'Feishu down' }),
    );
    expect(fixture.store.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.gateway.sendCard.mock.invocationCallOrder[0],
    );
    expect(fixture.store.markSent).not.toHaveBeenCalled();
  });

  it('shares one active run for concurrent calls on the same business date', async () => {
    const fixture = createFixture();
    let release!: (messageId: string) => void;
    fixture.gateway.sendCard.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const service = createService(fixture);

    const first = service.runForBusinessDate('2026-09-07');
    const second = service.runForBusinessDate('2026-09-07');

    expect(second).toBe(first);
    await Promise.resolve();
    release('om_patrol');
    await Promise.all([first, second]);
    expect(fixture.gateway.sendCard).toHaveBeenCalledTimes(1);
  });

  it('forwards the unified morning brief to the configured group gateway', async () => {
    const fixture = createFixture();
    const service = createService(fixture);
    const card = { schema: '2.0', header: { title: '统一早报' } };

    const messageId = await (
      service as unknown as {
        sendMorningBriefCard: (
          payload: Record<string, unknown>,
          businessDate: string,
        ) => Promise<string>;
      }
    ).sendMorningBriefCard(card, '2026-09-08');

    expect(messageId).toBe('om_patrol');
    expect(fixture.gateway.sendCard).toHaveBeenCalledWith(card, '2026-09-08');
    expect(fixture.store.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.store.markSent).toHaveBeenCalledWith(
      '2026-09-08',
      'om_patrol',
    );
  });

  it('updates the existing morning brief instead of posting a duplicate after recovery', async () => {
    const fixture = createFixture();
    fixture.store.getDelivery.mockResolvedValueOnce({
      businessDate: '2026-09-08',
      status: 'sent',
      digest: 'degraded-digest',
      messageId: 'om_existing_patrol',
      attempts: 1,
      lastError: '',
      createdAt: '2026-09-08T01:30:00.000Z',
      updatedAt: '2026-09-08T01:30:00.000Z',
      sentAt: '2026-09-08T01:30:00.000Z',
    });
    const service = createService(fixture);
    const recoveredCard = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '已恢复' } },
    };

    const messageId = await service.sendMorningBriefCard(
      recoveredCard,
      '2026-09-08',
    );

    expect(messageId).toBe('om_existing_patrol');
    expect(fixture.gateway.updateCard).toHaveBeenCalledWith(
      'om_existing_patrol',
      recoveredCard,
    );
    expect(fixture.gateway.sendCard).not.toHaveBeenCalled();
    expect(fixture.store.prepare).not.toHaveBeenCalled();
  });

  it('posts the versioned complete brief beside a legacy degraded card and then reuses it', async () => {
    const fixture = createFixture();
    const deliveries = new Map<string, Record<string, unknown>>([
      [
        '2026-09-11',
        {
          businessDate: '2026-09-11',
          status: 'sent',
          digest: 'legacy-degraded-digest',
          messageId: 'om_legacy_degraded',
        },
      ],
    ]);
    fixture.store.getDelivery.mockImplementation(
      async (businessDate: string, deliveryIdentity?: string) =>
        deliveries.get(
          deliveryIdentity
            ? `${businessDate}:${deliveryIdentity}`
            : businessDate,
        ) || null,
    );
    fixture.store.markSent.mockImplementation(
      async (
        businessDate: string,
        messageId: string,
        deliveryIdentity?: string,
      ) => {
        deliveries.set(`${businessDate}:${deliveryIdentity}`, {
          businessDate,
          status: 'sent',
          messageId,
        });
      },
    );
    const service = createService(fixture);
    const card = { schema: '2.0', header: { title: '完整统一巡视' } };

    await service.sendMorningBriefCard(card, '2026-09-11', 'unified-full-v4');
    await service.sendMorningBriefCard(card, '2026-09-11', 'unified-full-v4');

    expect(fixture.gateway.sendCard).toHaveBeenCalledTimes(1);
    expect(fixture.gateway.sendCard).toHaveBeenCalledWith(
      card,
      '2026-09-11',
      'unified-full-v4',
    );
    expect(fixture.gateway.updateCard).toHaveBeenCalledTimes(1);
    expect(fixture.gateway.updateCard).toHaveBeenCalledWith('om_patrol', card);
    expect(fixture.store.prepare).toHaveBeenCalledWith(
      '2026-09-11',
      expect.any(String),
      'unified-full-v4',
    );
    expect(fixture.store.markSent).toHaveBeenCalledWith(
      '2026-09-11',
      'om_patrol',
      'unified-full-v4',
    );
  });
});

function createService(fixture: ReturnType<typeof createFixture>) {
  return new DailyOperationsPatrolService(
    fixture.kpi as unknown as TodayOperationsKpiService,
    fixture.schedule as unknown as DutyScheduleService,
    fixture.bitable as unknown as BitableSyncService,
    fixture.store as unknown as DailyOperationsPatrolStore,
    fixture.gateway as unknown as DailyOperationsPatrolGateway,
    fixture.followUp as never,
  );
}

function createFixture() {
  const periods = [
    { date: '2026-09-06', rows: [{ building: 'A楼', value: 10 }] },
    { date: '2026-09-05', rows: [{ building: 'A楼', value: 10 }] },
    { date: '2026-09-04', rows: [{ building: 'A楼', value: 10 }] },
  ];
  return {
    kpi: {
      getKpisForAnomalyScan: jest.fn().mockResolvedValue({
        details: {
          buildingMetrics: {
            averagePue: { history: periods },
            electricityKwh: { history: periods },
            waterTons: { history: periods },
          },
        },
      }),
    },
    schedule: {
      getMonthlySchedules: jest.fn().mockResolvedValue([]),
      getYearlyChangeInfo: jest
        .fn()
        .mockResolvedValue({ changes: [], total: 0, keyTotal: 0 }),
      getYearlySealingInfo: jest
        .fn()
        .mockResolvedValue({ sealings: [], total: 0 }),
    },
    bitable: {
      getWeatherWarningFetchResult: jest.fn().mockResolvedValue({
        state: 'fresh',
        data: { code: '200', warning: [] },
        fetchedAt: '2026-09-07T01:30:00.000Z',
        warningCount: 0,
        isStale: false,
      }),
    },
    store: {
      isSent: jest.fn().mockResolvedValue(false),
      getDelivery: jest.fn().mockResolvedValue(null),
      prepare: jest.fn().mockResolvedValue(undefined),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    },
    gateway: {
      sendCard: jest.fn().mockResolvedValue('om_patrol'),
      updateCard: jest.fn().mockResolvedValue(undefined),
    },
    followUp: {
      syncMorningFollowUps: jest.fn().mockResolvedValue({
        recordIds: ['recPatrol'],
        followUpUrl:
          'https://sm.example.test/attendance-anomaly-follow-up?ticket=signed.ticket',
      }),
    },
  };
}
