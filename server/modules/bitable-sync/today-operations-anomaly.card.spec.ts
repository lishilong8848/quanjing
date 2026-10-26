import {
  buildTodayOperationsAnomalyCard,
  buildTodayOperationsAnomalyResolutionPromptCard,
  buildTodayOperationsAnomalyTerminalCard,
} from './today-operations-anomaly.card';
import { parseTodayOperationsAnomalyCardAction } from './today-operations-anomaly.callback';
import type {
  TodayOperationsAnomaly,
  TodayOperationsAnomalyEvent,
} from './today-operations-anomaly.types';

const anomaly: TodayOperationsAnomaly = {
  anomalyId: 'a'.repeat(64),
  businessDate: '2026-08-20',
  category: 'increase',
  metricKey: 'alarms.yesterdayTotal',
  metricLabel: '昨日告警总数',
  scope: '园区',
  location: '今日航图 > 03 园区近日告警信息总览 > 昨日告警总数',
  currentValue: 387,
  previousValue: 154,
  changePercent: 151.3,
  unit: '条',
  dataDate: '2026-08-19',
  comparisonDate: '2026-08-18',
  details: ['C楼 363条', 'D楼 16条'],
  detectedAt: '2026-08-20T00:30:00.000Z',
};

const anomalyEvent: TodayOperationsAnomalyEvent = {
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
      unit: '个',
      details: [],
    },
  ],
  detectedAt: anomaly.detectedAt,
};

describe('today operations anomaly cards and callbacks', () => {
  it('renders two initial actions without exposing the treatment input', () => {
    const card = buildTodayOperationsAnomalyCard(anomalyEvent, 'recAnomaly1');
    const text = JSON.stringify(card);

    expect(text).toContain('已知悉');
    expect(text).toContain('已处理');
    expect(text).not.toContain('today_operations_treatment_measure');
    expect(text).toContain('C楼 363条');
    expect(text).toContain('机柜上电数量（本周）');
    expect(text).toContain('共 2 项');
  });

  it('renders the treatment input only in the resolution prompt', () => {
    const card = buildTodayOperationsAnomalyResolutionPromptCard(
      anomalyEvent,
      'recAnomaly1',
    );
    const text = JSON.stringify(card);
    const submitName = findResolutionSubmitName(card);

    expect(text).toContain('today_operations_treatment_measure');
    expect(text).toContain('form_action_type');
    expect(text).toContain('提交处理结果');
    expect(text).not.toContain('已知悉');
    expect(submitName).toBe(
      `today_operations_resolve_submit:${anomalyEvent.anomalyEventId}`,
    );
    expect(submitName.length).toBeLessThanOrEqual(100);
  });

  it('parses acknowledge and open-resolution button actions', () => {
    expect(
      parseTodayOperationsAnomalyCardAction(
        buttonPayload('acknowledge', 'event-ack'),
      ),
    ).toMatchObject({ kind: 'terminal', action: 'acknowledged' });
    expect(
      parseTodayOperationsAnomalyCardAction(
        buttonPayload('open_resolution', 'event-open'),
      ),
    ).toMatchObject({ kind: 'view', view: 'resolution' });
  });

  it('requires a 2-500 character treatment measure before resolving', () => {
    expect(() =>
      parseTodayOperationsAnomalyCardAction(formPayload(' ')),
    ).toThrow('处理措施需填写 2–500 字');
    expect(
      parseTodayOperationsAnomalyCardAction(formPayload('已核查并完成处置')),
    ).toMatchObject({
      kind: 'terminal',
      action: 'resolved',
      treatmentMeasure: '已核查并完成处置',
    });
  });

  it('renders a terminal card with treatment details and no callbacks', () => {
    const card = buildTodayOperationsAnomalyTerminalCard(anomalyEvent, {
      recordId: 'recAnomaly1',
      terminal: 'resolved',
      actorName: '处理人',
      handledAt: '2026-08-20T01:00:00.000Z',
      treatmentMeasure: '完成设备检查并恢复数据采集',
      synced: true,
    });
    const text = JSON.stringify(card);

    expect(text).toContain('完成设备检查并恢复数据采集');
    expect(text).toContain('已处理');
    expect(text).not.toContain('callback');
  });

  it('keeps the resolution action available after acknowledgement', () => {
    const result = {
      terminal: 'acknowledged' as const,
      actorName: '处理人',
      handledAt: '2026-08-20T01:00:00.000Z',
      synced: true,
      recordId: 'recAnomaly1',
    } as Parameters<typeof buildTodayOperationsAnomalyTerminalCard>[1] & {
      recordId: string;
    };
    const card = buildTodayOperationsAnomalyTerminalCard(anomalyEvent, result);
    const text = JSON.stringify(card);

    expect(text).toContain('已知悉，待处理');
    expect(text).toContain('open_resolution');
    expect(text).toContain('recAnomaly1');
  });

  it('renders schedule consistency as a pending verification instead of missing data', () => {
    const scheduleEvent: TodayOperationsAnomalyEvent = {
      anomalyEventId: 'c'.repeat(64),
      businessDate: '2026-08-30',
      anomalies: [
        {
          ...anomaly,
          businessDate: '2026-08-30',
          category: 'missing',
          metricKey: 'scheduleConsistency.approved_substitute_missing.issue-1',
          metricLabel: '已审批替班未更新排班',
          scope: '2026-08-30 110站 白班',
          location: '排班页面 > 2026-08-30 110站 白班',
          currentValue: null,
          previousValue: null,
          changePercent: null,
          details: ['已审批替班人员“周庆庆”未出现在该班次实际排班中'],
          dataDate: '2026-08-30',
          comparisonDate: null,
        },
      ],
      detectedAt: anomaly.detectedAt,
    };
    const card = buildTodayOperationsAnomalyCard(scheduleEvent, 'recSchedule');
    const text = JSON.stringify(card);

    expect((card.header as { template?: string }).template).toBe('orange');
    expect(text).toContain('排班一致性待核验');
    expect(text).not.toContain('数据不可用');
    expect(text).not.toContain('当前 / 对比');
    expect(text).not.toContain('数据缺失');
  });

  it('keeps an actual source failure red and labelled as missing data', () => {
    const sourceEvent: TodayOperationsAnomalyEvent = {
      anomalyEventId: 'd'.repeat(64),
      businessDate: '2026-08-30',
      anomalies: [
        {
          ...anomaly,
          businessDate: '2026-08-30',
          category: 'missing',
          metricKey: 'scheduleConsistencySource',
          metricLabel: '排班一致性数据源',
          currentValue: null,
          previousValue: null,
          changePercent: null,
          details: ['排班数据源读取失败'],
          dataDate: '2026-08-30',
          comparisonDate: null,
        },
      ],
      detectedAt: anomaly.detectedAt,
    };
    const card = buildTodayOperationsAnomalyCard(sourceEvent, 'recSource');

    expect((card.header as { template?: string }).template).toBe('red');
    expect(JSON.stringify(card)).toContain('数据缺失');
  });

  it('renders yesterday attendance as an explicit anomaly including substitute identity', () => {
    const attendanceEvent: TodayOperationsAnomalyEvent = {
      anomalyEventId: 'f'.repeat(64),
      businessDate: '2026-08-30',
      anomalies: [
        {
          ...anomaly,
          businessDate: '2026-08-30',
          category: 'missing',
          metricKey: 'attendance.2026-08-29.building_c.white.OnDuty.gu-xiaolei',
          metricLabel: '昨日考勤异常',
          scope: 'C楼 · 顾晓磊',
          location: '排班页面 > 2026-08-29 C楼 白班',
          currentValue: null,
          previousValue: null,
          changePercent: null,
          details: ['替班人员；上班卡应打 09:00；未打卡'],
          dataDate: '2026-08-29',
          comparisonDate: null,
        },
      ],
      detectedAt: anomaly.detectedAt,
    };

    const card = buildTodayOperationsAnomalyCard(
      attendanceEvent,
      'recAttendance',
    );
    const text = JSON.stringify(card);

    expect(text).toContain('昨日考勤异常');
    expect(text).toContain('顾晓磊');
    expect(text).toContain('替班人员');
    expect(text).toContain('未打卡');
    expect(text).not.toContain('数据不可用');
    expect(text).not.toContain('待核对');
  });
});

function buttonPayload(
  action: string,
  eventId: string,
): Record<string, unknown> {
  return {
    event_type: 'card.action.trigger',
    event_id: eventId,
    operator: { open_id: `ou_${'a'.repeat(20)}` },
    context: { open_message_id: `om_${'b'.repeat(20)}` },
    action: {
      tag: 'button',
      value: {
        workflowType: 'today_operations_anomaly',
        version: 1,
        action,
        anomalyEventId: anomalyEvent.anomalyEventId,
        recordId: 'recAnomaly1',
      },
    },
  };
}

function formPayload(measure: string): Record<string, unknown> {
  return {
    event_type: 'card.action.trigger',
    event_id: 'event-resolve',
    operator: { open_id: `ou_${'a'.repeat(20)}` },
    context: { open_message_id: `om_${'b'.repeat(20)}` },
    action: {
      tag: 'button',
      name: `today_operations_resolve_submit:${anomalyEvent.anomalyEventId}`,
      form_value: { today_operations_treatment_measure: measure },
    },
  };
}

function findResolutionSubmitName(card: Record<string, unknown>): string {
  const body = card.body as { elements?: Array<Record<string, unknown>> };
  const form = body.elements?.find((element) => element.tag === 'form') as {
    elements?: Array<Record<string, unknown>>;
  };
  const submit = form.elements?.find(
    (element) => element.form_action_type === 'submit',
  );
  return String(submit?.name || '');
}
