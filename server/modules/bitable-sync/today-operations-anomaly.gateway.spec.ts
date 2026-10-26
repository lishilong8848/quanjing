import {
  areTodayOperationsFieldValuesEqual,
  assertTodayOperationsAnomalyFieldSchema,
  buildTodayOperationsAnomalyDescription,
  buildTodayOperationsAnomalyItem,
  buildTodayOperationsAnomalyTerminalFields,
  buildTodayOperationsFollowUpObjectiveFields,
  buildTodayOperationsFollowUpUpdateFields,
  normalizeTodayOperationsFollowUpRecord,
  stableTodayOperationsAnomalyMessageUuid,
} from './today-operations-anomaly.gateway';
import type {
  TodayOperationsAnomaly,
  TodayOperationsAnomalyEvent,
} from './today-operations-anomaly.types';

describe('today operations anomaly Base mapping', () => {
  it('treats Feishu empty text representations as semantically equal', () => {
    expect(areTodayOperationsFieldValuesEqual(undefined, '')).toBe(true);
    expect(areTodayOperationsFieldValuesEqual(null, '')).toBe(true);
    expect(areTodayOperationsFieldValuesEqual([], '')).toBe(true);
  });

  it('uses a Feishu-compatible stable message UUID', () => {
    const uuid = stableTodayOperationsAnomalyMessageUuid('a'.repeat(64));
    expect(uuid).toMatch(/^toa_[a-f0-9]{40}$/u);
    expect(uuid.length).toBeLessThanOrEqual(50);
    expect(stableTodayOperationsAnomalyMessageUuid('a'.repeat(64))).toBe(uuid);
  });

  it('requires the unified follow-up field names and types', () => {
    expect(() =>
      assertTodayOperationsAnomalyFieldSchema([
        { field_name: '日期', type: 5 },
        { field_name: '异常项', type: 1 },
        { field_name: '异常说明', type: 1 },
        { field_name: '异常类型', type: 3 },
        { field_name: '已知悉', type: 7 },
        { field_name: '已处理完成', type: 7 },
        { field_name: '处理措施', type: 1 },
        { field_name: '异常唯一键', type: 1 },
        { field_name: '来源', type: 3 },
        { field_name: '楼栋', type: 1 },
        { field_name: '最近发现时间', type: 5 },
        { field_name: '处理人姓名', type: 1 },
        { field_name: '处理时间', type: 5 },
        { field_name: '客户端变更ID', type: 1 },
      ]),
    ).not.toThrow();
    expect(() =>
      assertTodayOperationsAnomalyFieldSchema([
        { field_name: '日期', type: 1 },
        { field_name: '异常项', type: 1 },
        { field_name: '异常说明', type: 1 },
        { field_name: '已知悉', type: 7 },
        { field_name: '已处理完成', type: 7 },
        { field_name: '处理措施', type: 1 },
      ]),
    ).toThrow('日期');
  });

  it('maps objective event fields without overwriting human follow-up fields', () => {
    const event = { ...sampleEvent(), followUpSource: '每日巡视' as const };
    const fields = buildTodayOperationsFollowUpObjectiveFields(event);

    expect(fields).toMatchObject({
      异常唯一键: event.anomalyEventId,
      来源: '每日巡视',
      异常类型: '运行异常',
      楼栋: '园区',
    });
    expect(fields).not.toHaveProperty('已知悉');
    expect(fields).not.toHaveProperty('已处理完成');
    expect(fields).not.toHaveProperty('处理措施');
    expect(fields['最近发现时间']).toBe(Date.parse('2026-08-20T00:30:00.000Z'));
  });

  it('normalizes follow-up rows and validates idempotent completion updates', () => {
    const record = normalizeTodayOperationsFollowUpRecord({
      record_id: 'recFollowUp01',
      fields: {
        日期: Date.parse('2026-08-20T00:00:00+08:00'),
        异常唯一键: 'issue-key-01',
        来源: '每日巡视',
        异常项: '排班连班风险',
        异常说明: 'H楼夜班后接白班',
        楼栋: 'H楼',
        已知悉: true,
        已处理完成: false,
        处理措施: '已通知值班长',
        处理人姓名: '值班长',
        处理时间: Date.parse('2026-08-20T09:00:00+08:00'),
      },
    });
    expect(record).toMatchObject({
      recordId: 'recFollowUp01',
      issueKey: 'issue-key-01',
      date: '2026-08-20',
      source: '每日巡视',
      building: 'H楼',
      acknowledged: true,
      completed: false,
    });

    expect(
      buildTodayOperationsFollowUpUpdateFields({
        recordId: 'recFollowUp01',
        acknowledged: true,
        completed: true,
        treatmentMeasure: '完成换班并复核',
        handlerName: '值班长',
        clientMutationId: 'mutation-follow-up-0001',
      }),
    ).toMatchObject({
      已知悉: true,
      已处理完成: true,
      处理措施: '完成换班并复核',
      处理人姓名: '值班长',
      客户端变更ID: 'mutation-follow-up-0001',
    });
    expect(() =>
      buildTodayOperationsFollowUpUpdateFields({
        recordId: 'recFollowUp01',
        acknowledged: true,
        completed: true,
        treatmentMeasure: '',
        clientMutationId: 'mutation-follow-up-0002',
      }),
    ).toThrow('处理措施');
  });

  it('preserves concise anomaly evidence while terminal fields carry status separately', () => {
    const anomalyEvent = sampleEvent();
    const fields = buildTodayOperationsAnomalyTerminalFields(anomalyEvent, {
      terminal: 'resolved',
      actorName: '处理人',
      handledAt: '2026-08-20T01:00:00.000Z',
      treatmentMeasure: '完成检查并恢复采集',
    });

    expect(fields['已知悉']).toBe(true);
    expect(fields['已处理完成']).toBe(true);
    expect(fields['异常说明']).toContain(
      buildTodayOperationsAnomalyDescription(anomalyEvent),
    );
    expect(fields['处理措施']).toBe('完成检查并恢复采集');
    expect(fields['异常说明']).not.toContain('处理人：');
    expect(fields['异常说明']).not.toContain('处理时间：');
    expect(fields['异常说明']).not.toContain('处理状态：');
  });

  it('states the anomaly directly and keeps the explanation specific and concise', () => {
    const anomalyEvent = sampleEvent();
    expect(buildTodayOperationsAnomalyItem(anomalyEvent)).toBe(
      '昨日告警总数异常上涨；机柜上电数量（本周）异常上涨',
    );
    const description = buildTodayOperationsAnomalyDescription(anomalyEvent);
    expect(description).toContain(
      '1. 昨日告警总数（园区）：154条 → 387条（+151.3%）',
    );
    expect(description).toContain(
      '2. 机柜上电数量（本周）（园区）：0个 → 28个（由 0 突增）',
    );
    expect(description).toContain('明细：C楼 363条');
    expect(description).not.toContain('事件日期：');
    expect(description).not.toContain('异常数量：');
    expect(description).not.toContain('异常事件标识：');
    expect(description).not.toContain('异常标识：');
  });

  it('acknowledges without marking completed or inventing a treatment measure', () => {
    const fields = buildTodayOperationsAnomalyTerminalFields(sampleEvent(), {
      terminal: 'acknowledged',
      actorName: '处理人',
      handledAt: '2026-08-20T01:00:00.000Z',
    });
    expect(fields).toMatchObject({ 已知悉: true, 已处理完成: false });
    expect(fields['处理措施']).toBe('');
  });

  it('writes schedule mismatches as pending verification rather than missing data', () => {
    const scheduleAnomaly: TodayOperationsAnomaly = {
      ...sampleAnomaly(),
      category: 'missing',
      metricKey: 'scheduleConsistency.approved_substitute_missing.issue-1',
      metricLabel: '已审批替班未更新排班',
      scope: '2026-08-30 110站 白班',
      currentValue: null,
      previousValue: null,
      changePercent: null,
      comparisonDate: null,
    };
    const event: TodayOperationsAnomalyEvent = {
      anomalyEventId: 's'.repeat(64),
      businessDate: '2026-08-30',
      anomalies: [scheduleAnomaly],
      detectedAt: scheduleAnomaly.detectedAt,
    };

    expect(buildTodayOperationsAnomalyItem(event)).toContain(
      '排班一致性待核验',
    );
    expect(buildTodayOperationsAnomalyDescription(event)).toContain(
      '排班信息不一致，待核验',
    );
    expect(buildTodayOperationsAnomalyDescription(event)).not.toContain(
      '数据缺失',
    );
  });
});

function sampleEvent(): TodayOperationsAnomalyEvent {
  const anomaly = sampleAnomaly();
  return {
    anomalyEventId: 'e'.repeat(64),
    businessDate: anomaly.businessDate,
    anomalies: [
      anomaly,
      {
        ...anomaly,
        anomalyId: 'b'.repeat(64),
        metricKey: 'rack.poweredOnThisWeek',
        metricLabel: '机柜上电数量（本周）',
        location: '今日航图 > 01 机柜使用概览 > 机柜上电数量（本周）',
        currentValue: 28,
        previousValue: 0,
        changePercent: null,
        unit: '个',
        details: [],
      },
    ],
    detectedAt: anomaly.detectedAt,
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
    location: '今日航图 > 03 告警 > 昨日告警总数',
    currentValue: 387,
    previousValue: 154,
    changePercent: 151.3,
    unit: '条',
    dataDate: '2026-08-19',
    comparisonDate: '2026-08-18',
    details: ['C楼 363条', 'D楼 16条'],
    detectedAt: '2026-08-20T00:30:00.000Z',
  };
}
