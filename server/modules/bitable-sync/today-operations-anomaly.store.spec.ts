import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodayOperationsAnomalyStore } from './today-operations-anomaly.store';
import type { TodayOperationsAnomaly } from './today-operations-anomaly.types';

describe('TodayOperationsAnomalyStore', () => {
  it('persists a completed discovery date without breaking an existing v2 ledger', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const path = join(directory, 'ledger.json');
    await writeFile(path, JSON.stringify({ version: 2, entries: [] }), 'utf8');
    const store = new TodayOperationsAnomalyStore(path);

    expect(await store.isBusinessDateScanCompleted('2026-08-30')).toBe(false);
    await store.markBusinessDateScanCompleted('2026-08-30');
    await store.markBusinessDateScanCompleted('2026-08-30');

    const reloaded = new TodayOperationsAnomalyStore(path);
    expect(await reloaded.isBusinessDateScanCompleted('2026-08-30')).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).completedScanDates).toEqual(
      ['2026-08-30'],
    );
  });

  it('deduplicates discovery and atomically accepts only the first terminal action', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const path = join(directory, 'ledger.json');
    const store = new TodayOperationsAnomalyStore(path);
    const anomalies = [sampleAnomaly(), sampleRackAnomaly()];

    const firstDiscovery = await store.discoverAll(anomalies);
    expect(firstDiscovery.created).toBe(true);
    expect((await store.discoverAll(anomalies)).created).toBe(false);
    const anomalyEventId = firstDiscovery.entry.anomalyEvent.anomalyEventId;
    await store.markBaseReady(anomalyEventId, 'recAnomaly1');
    await store.markCardSent(anomalyEventId, 'om_message1');

    const [first, replay] = await Promise.all([
      store.claimTerminal({
        anomalyEventId,
        eventId: 'event-1',
        terminal: 'resolved',
        actorOpenId: `ou_${'a'.repeat(20)}`,
        actorName: '处理人',
        messageId: 'om_message1',
        treatmentMeasure: '完成检查并恢复采集',
      }),
      store.claimTerminal({
        anomalyEventId,
        eventId: 'event-2',
        terminal: 'acknowledged',
        actorOpenId: `ou_${'b'.repeat(20)}`,
        actorName: '另一处理人',
        messageId: 'om_message1',
      }),
    ]);

    expect([first.claimed, replay.claimed].filter(Boolean)).toHaveLength(1);
    const entry = await store.get(anomalyEventId);
    expect(entry?.anomalyEvent.anomalies).toHaveLength(2);
    expect(entry?.terminal).toBe(first.claimed ? 'resolved' : 'acknowledged');
    expect(entry?.syncStatus).toBe('pending');
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(2);
  });

  it('persists a retryable sync failure without losing the treatment measure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const store = new TodayOperationsAnomalyStore(
      join(directory, 'ledger.json'),
    );
    const anomaly = sampleAnomaly();
    const discovery = await store.discoverAll([anomaly]);
    const anomalyEventId = discovery.entry.anomalyEvent.anomalyEventId;
    await store.markBaseReady(anomalyEventId, 'recAnomaly1');
    await store.markCardSent(anomalyEventId, 'om_message1');
    await store.claimTerminal({
      anomalyEventId,
      eventId: 'event-1',
      terminal: 'resolved',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      actorName: '处理人',
      messageId: 'om_message1',
      treatmentMeasure: '完成检查并恢复采集',
    });

    await store.markSyncFailed(
      anomalyEventId,
      new Error('temporary token error'),
      new Date('2026-08-20T01:00:00Z'),
    );
    const pending = await store.listPendingSync(
      new Date('2026-08-20T02:00:00Z'),
    );

    expect(pending).toHaveLength(1);
    expect(pending[0].treatmentMeasure).toBe('完成检查并恢复采集');
    expect(pending[0].lastError).not.toContain('token error');
  });

  it('creates a new active batch when a new anomaly appears after the earlier batch was resolved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const store = new TodayOperationsAnomalyStore(
      join(directory, 'ledger.json'),
    );
    const first = await store.discoverAll([sampleAnomaly()]);
    await store.markBaseReady(
      first.entry.anomalyEvent.anomalyEventId,
      'recFirst',
    );
    await store.markCardSent(
      first.entry.anomalyEvent.anomalyEventId,
      'om_first',
    );
    await store.claimTerminal({
      anomalyEventId: first.entry.anomalyEvent.anomalyEventId,
      eventId: 'event-first-resolved',
      terminal: 'resolved',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      actorName: '处理人',
      messageId: 'om_first',
      treatmentMeasure: '已完成第一批处置',
    });
    await store.markSynced(first.entry.anomalyEvent.anomalyEventId);

    const scheduleMismatch = {
      ...sampleAnomaly(),
      anomalyId: 'c'.repeat(64),
      metricKey: 'scheduleConsistency.approved_substitute_missing.issue',
      metricLabel: '已审批替班未更新排班',
      scope: '2026-08-22 A栋 夜班',
    };
    const next = await store.discoverAll([sampleAnomaly(), scheduleMismatch]);
    const replay = await store.discoverAll([sampleAnomaly(), scheduleMismatch]);

    expect(next.created).toBe(true);
    expect(next.entry.anomalyEvent.anomalyEventId).not.toBe(
      first.entry.anomalyEvent.anomalyEventId,
    );
    expect(next.entry.terminal).toBeNull();
    expect(next.entry.anomalyEvent.anomalies).toEqual([scheduleMismatch]);
    expect(replay.created).toBe(false);
    expect(replay.entry.anomalyEvent.anomalyEventId).toBe(
      next.entry.anomalyEvent.anomalyEventId,
    );
  });

  it('atomically upgrades an acknowledged event to resolved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const store = new TodayOperationsAnomalyStore(
      join(directory, 'ledger.json'),
    );
    const discovery = await store.discoverAll([sampleAnomaly()]);
    const anomalyEventId = discovery.entry.anomalyEvent.anomalyEventId;
    await store.markBaseReady(anomalyEventId, 'recAnomaly1');
    await store.markCardSent(anomalyEventId, 'om_message1');

    const acknowledged = await store.claimTerminal({
      anomalyEventId,
      eventId: 'event-acknowledged',
      terminal: 'acknowledged',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      actorName: '知悉人',
      messageId: 'om_message1',
    });
    await store.markSynced(anomalyEventId);
    const resolved = await store.claimTerminal({
      anomalyEventId,
      eventId: 'event-resolved',
      terminal: 'resolved',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      actorName: '处理人',
      messageId: 'om_message1',
      treatmentMeasure: '完成检查并恢复采集',
    });
    const acknowledgedReplay = await store.claimTerminal({
      anomalyEventId,
      eventId: 'event-acknowledged-replay',
      terminal: 'acknowledged',
      actorOpenId: `ou_${'a'.repeat(20)}`,
      actorName: '知悉人',
      messageId: 'om_message1',
    });

    expect(acknowledged.claimed).toBe(true);
    expect(resolved.claimed).toBe(true);
    expect(acknowledgedReplay.claimed).toBe(false);
    expect((await store.get(anomalyEventId))?.terminal).toBe('resolved');
    expect((await store.get(anomalyEventId))?.treatmentMeasure).toBe(
      '完成检查并恢复采集',
    );
  });

  it('removes recovered schedule consistency items while preserving other anomalies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const store = new TodayOperationsAnomalyStore(
      join(directory, 'ledger.json'),
    );
    const discovery = await store.discoverAll([
      sampleAnomaly(),
      sampleScheduleAnomaly(),
    ]);
    const anomalyEventId = discovery.entry.anomalyEvent.anomalyEventId;
    await store.markBaseReady(anomalyEventId, 'recAnomaly1');
    await store.markCardSent(anomalyEventId, 'om_message1');
    await store.markProvisioned(anomalyEventId);

    await store.reconcileScheduleConsistency(
      sampleAnomaly().businessDate,
      [],
      new Date('2026-08-20T01:15:00.000Z'),
    );

    const entry = await store.get(anomalyEventId);
    expect(entry?.anomalyEvent.anomalies).toEqual([sampleAnomaly()]);
    expect(entry?.terminal).toBeNull();
    expect(entry?.provisionStatus).toBe('pending');
  });

  it('automatically resolves an event when all schedule consistency items recover', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const store = new TodayOperationsAnomalyStore(
      join(directory, 'ledger.json'),
    );
    const scheduleAnomaly = sampleScheduleAnomaly();
    const discovery = await store.discoverAll([scheduleAnomaly]);
    const anomalyEventId = discovery.entry.anomalyEvent.anomalyEventId;
    await store.markBaseReady(anomalyEventId, 'recAnomaly1');
    await store.markCardSent(anomalyEventId, 'om_message1');
    await store.markProvisioned(anomalyEventId);

    await store.reconcileScheduleConsistency(
      scheduleAnomaly.businessDate,
      [],
      new Date('2026-08-20T01:15:00.000Z'),
    );

    const entry = await store.get(anomalyEventId);
    expect(entry?.terminal).toBe('resolved');
    expect(entry?.actorName).toBe('系统自动复核');
    expect(entry?.treatmentMeasure).toBe('排班数据已恢复一致');
    expect(entry?.syncStatus).toBe('pending');
  });

  it('validates the record and callback message inside the atomic terminal claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const store = new TodayOperationsAnomalyStore(
      join(directory, 'ledger.json'),
    );
    const discovery = await store.discoverAll([sampleAnomaly()]);
    const anomalyEventId = discovery.entry.anomalyEvent.anomalyEventId;
    await store.markBaseReady(anomalyEventId, 'recAnomaly1');
    await store.markCardSent(anomalyEventId, 'om_message1');

    await expect(
      store.claimTerminal({
        anomalyEventId,
        recordId: 'recOther',
        eventId: 'event-wrong-record',
        terminal: 'resolved',
        actorOpenId: `ou_${'a'.repeat(20)}`,
        actorName: '处理人',
        messageId: 'om_message1',
        treatmentMeasure: '不应写入',
      }),
    ).rejects.toThrow('今日航图异常事件不存在');
    await expect(
      store.claimTerminal({
        anomalyEventId,
        recordId: 'recAnomaly1',
        eventId: 'event-wrong-message',
        terminal: 'resolved',
        actorOpenId: `ou_${'a'.repeat(20)}`,
        actorName: '处理人',
        messageId: 'om_other_message',
        treatmentMeasure: '不应写入',
      }),
    ).rejects.toThrow('今日航图异常事件不存在');
    expect((await store.get(anomalyEventId))?.terminal).toBeNull();
  });

  it('migrates two legacy rows for the same date into one event and schedules duplicate cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'today-anomaly-'));
    const path = join(directory, 'ledger.json');
    const alarm = sampleAnomaly();
    const rack = sampleRackAnomaly();
    const legacyEntry = (
      anomaly: TodayOperationsAnomaly,
      recordId: string,
    ) => ({
      anomaly,
      recordId,
      messageId: `om_${recordId}`,
      terminal: anomaly.metricKey.startsWith('alarms') ? 'acknowledged' : null,
      terminalEventId: anomaly.metricKey,
      actorOpenId: '',
      actorName: '马进宇',
      handledAt: anomaly.detectedAt,
      treatmentMeasure: '',
      syncStatus: anomaly.metricKey.startsWith('alarms') ? 'completed' : 'idle',
      syncAttempts: 0,
      nextAttemptAt: anomaly.detectedAt,
      lastError: '',
      createdAt: anomaly.detectedAt,
      updatedAt: anomaly.detectedAt,
    });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [legacyEntry(alarm, 'recAlarm'), legacyEntry(rack, 'recRack')],
      }),
      'utf8',
    );

    const store = new TodayOperationsAnomalyStore(path);
    const entries = await store.listUnprovisioned();

    expect(entries).toHaveLength(1);
    expect(entries[0].anomalyEvent.anomalies).toHaveLength(2);
    expect(entries[0].recordId).toBe('recAlarm');
    expect(entries[0].duplicateRecordIds).toEqual(['recRack']);
    expect(entries[0].messageIds).toHaveLength(2);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(2);
  });
});

function sampleRackAnomaly(): TodayOperationsAnomaly {
  return {
    ...sampleAnomaly(),
    anomalyId: 'b'.repeat(64),
    metricKey: 'rack.poweredOnThisWeek',
    metricLabel: '机柜上电数量（本周）',
    location: '今日航图 > 01 机柜使用概览 > 机柜上电数量（本周）',
    currentValue: 28,
    previousValue: 0,
    unit: '个',
    details: [],
  };
}

function sampleScheduleAnomaly(): TodayOperationsAnomaly {
  return {
    ...sampleAnomaly(),
    anomalyId: 'c'.repeat(64),
    metricKey: 'scheduleConsistency.approved_substitute_missing.issue',
    metricLabel: '已审批替班未更新排班',
    scope: '2026-08-20 B栋 白班',
  };
}

function sampleAnomaly(): TodayOperationsAnomaly {
  return {
    anomalyId: 'a'.repeat(64),
    businessDate: '2026-08-20',
    category: 'increase',
    metricKey: 'alarms.yesterdayTotal',
    metricLabel: '昨日告警总数',
    scope: '园区',
    location: '今日航图 > 告警 > 昨日告警总数',
    currentValue: 387,
    previousValue: 154,
    changePercent: 151.3,
    unit: '条',
    dataDate: '2026-08-19',
    comparisonDate: '2026-08-18',
    details: ['C楼 363条'],
    detectedAt: '2026-08-20T00:30:00.000Z',
  };
}
