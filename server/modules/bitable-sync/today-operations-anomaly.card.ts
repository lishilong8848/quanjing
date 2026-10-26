import type {
  TodayOperationsAnomaly,
  TodayOperationsAnomalyEvent,
  TodayOperationsAnomalyTerminal,
} from './today-operations-anomaly.types';

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const EVENT_ID_PATTERN = /^[a-f0-9]{64}$/u;

export function buildTodayOperationsAnomalyCard(
  anomalyEvent: TodayOperationsAnomalyEvent,
  recordId: string,
): Record<string, unknown> {
  validate(anomalyEvent, recordId);
  return buildCard(templateFor(anomalyEvent), titleFor(anomalyEvent), [
    ...summary(anomalyEvent),
    {
      tag: 'column_set',
      horizontal_spacing: '8px',
      columns: [
        actionColumn(
          '已知悉',
          'default',
          'acknowledge',
          anomalyEvent,
          recordId,
        ),
        actionColumn(
          '已处理',
          'primary_filled',
          'open_resolution',
          anomalyEvent,
          recordId,
        ),
      ],
    },
  ]);
}

export function buildTodayOperationsAnomalyResolutionPromptCard(
  anomalyEvent: TodayOperationsAnomalyEvent,
  recordId: string,
): Record<string, unknown> {
  validate(anomalyEvent, recordId);
  return buildCard('orange', '今日航图异常 · 填写处理措施', [
    ...summary(anomalyEvent),
    {
      tag: 'markdown',
      content:
        '<font color="grey">尚未标记为已处理；填写并提交处理措施后才会回填多维表。</font>',
    },
    {
      tag: 'form',
      name: 'today_operations_resolution_form',
      direction: 'vertical',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'input',
          name: 'today_operations_treatment_measure',
          required: true,
          input_type: 'multiline_text',
          max_length: 500,
          rows: 3,
          width: 'fill',
          label: { tag: 'plain_text', content: '处理措施' },
          placeholder: {
            tag: 'plain_text',
            content: '必填，请填写具体检查、修复或跟进措施（2–500 字）',
          },
        },
        {
          tag: 'button',
          name: `today_operations_resolve_submit:${anomalyEvent.anomalyEventId}`,
          type: 'primary_filled',
          width: 'fill',
          form_action_type: 'submit',
          text: { tag: 'plain_text', content: '提交处理结果' },
        },
      ],
    },
    actionButton(
      '返回',
      'default',
      'return_to_anomaly',
      anomalyEvent,
      recordId,
    ),
  ]);
}

export function buildTodayOperationsAnomalySyncingCard(
  anomalyEvent: TodayOperationsAnomalyEvent,
  terminal: TodayOperationsAnomalyTerminal,
): Record<string, unknown> {
  return buildCard('orange', '今日航图异常 · 正在同步', [
    ...summary(anomalyEvent),
    {
      tag: 'markdown',
      content: `<font color="orange">${terminal === 'resolved' ? '处理结果' : '知悉状态'}已受理，正在回填多维表。</font>`,
    },
    disabledActions('后台同步完成后自动更新'),
  ]);
}

export function buildTodayOperationsAnomalyTerminalCard(
  anomalyEvent: TodayOperationsAnomalyEvent,
  result: {
    recordId: string;
    terminal: TodayOperationsAnomalyTerminal;
    actorName: string;
    handledAt: string;
    treatmentMeasure?: string;
    synced: boolean;
  },
): Record<string, unknown> {
  const resolved = result.terminal === 'resolved';
  validate(anomalyEvent, result.recordId);
  return buildCard(
    result.synced ? 'green' : 'orange',
    resolved ? '今日航图异常 · 已处理' : '今日航图异常 · 已知悉，待处理',
    [
      ...summary(anomalyEvent),
      detail('处理状态', resolved ? '已处理' : '已知悉，待处理'),
      detail('操作人', result.actorName),
      detail('操作时间', formatShanghai(result.handledAt)),
      ...(resolved && result.treatmentMeasure
        ? [detail('处理措施', result.treatmentMeasure)]
        : []),
      resolved
        ? disabledActions(result.synced ? '该事件已完成处置' : '状态等待同步')
        : acknowledgedActions(anomalyEvent, result.recordId),
    ],
  );
}

function buildCard(
  template: 'blue' | 'green' | 'orange' | 'red',
  title: string,
  elements: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements,
    },
  };
}

function summary(
  anomalyEvent: TodayOperationsAnomalyEvent,
): Array<Record<string, unknown>> {
  return [
    detail(
      '异常概况',
      `${anomalyEvent.businessDate} · 共 ${anomalyEvent.anomalies.length} 项`,
    ),
    ...anomalyEvent.anomalies.flatMap((anomaly, index) => [
      ...(index ? [{ tag: 'hr' }] : []),
      ...anomalySummary(anomaly, index + 1),
    ]),
  ];
}

function anomalySummary(
  anomaly: TodayOperationsAnomaly,
  index: number,
): Array<Record<string, unknown>> {
  const scheduleConsistency = isScheduleConsistencyAnomaly(anomaly);
  const attendance = isAttendanceAnomaly(anomaly);
  const values =
    anomaly.category === 'missing'
      ? '数据不可用'
      : `${displayNumber(anomaly.previousValue)}${anomaly.unit} → ${displayNumber(anomaly.currentValue)}${anomaly.unit}`;
  const change =
    anomaly.changePercent === null
      ? anomaly.category === 'increase'
        ? '由 0 突增'
        : '—'
      : `${anomaly.changePercent > 0 ? '+' : ''}${anomaly.changePercent}%`;
  return [
    detail(
      `${index}. ${attendance ? '考勤异常' : scheduleConsistency ? '排班一致性待核验' : categoryLabel(anomaly.category)}`,
      `${anomaly.metricLabel} · ${anomaly.scope}`,
    ),
    detail(attendance ? '排班定位' : '定位', anomaly.location),
    ...(scheduleConsistency || attendance
      ? []
      : [
          {
            tag: 'column_set',
            horizontal_spacing: '8px',
            columns: [
              metricColumn('当前 / 对比', values),
              metricColumn('变化', change),
            ],
          },
        ]),
    ...(anomaly.details.length
      ? [detail('异常明细', anomaly.details.join('；'))]
      : []),
    detail(
      '数据日期',
      [anomaly.dataDate, anomaly.comparisonDate].filter(Boolean).join(' / ') ||
        anomaly.businessDate,
    ),
  ];
}

function actionColumn(
  label: string,
  type: 'default' | 'primary_filled',
  action: 'acknowledge' | 'open_resolution',
  anomalyEvent: TodayOperationsAnomalyEvent,
  recordId: string,
): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [actionButton(label, type, action, anomalyEvent, recordId)],
  };
}

function actionButton(
  label: string,
  type: 'default' | 'primary_filled',
  action: 'acknowledge' | 'open_resolution' | 'return_to_anomaly',
  anomalyEvent: TodayOperationsAnomalyEvent,
  recordId: string,
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    width: 'fill',
    text: { tag: 'plain_text', content: label },
    behaviors: [
      {
        type: 'callback',
        value: {
          workflowType: 'today_operations_anomaly',
          version: 1,
          action,
          anomalyEventId: anomalyEvent.anomalyEventId,
          recordId,
        },
      },
    ],
  };
}

function disabledActions(tip: string): Record<string, unknown> {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: ['已知悉', '已处理'].map((label) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'button',
          type: 'default',
          width: 'fill',
          disabled: true,
          disabled_tips: { tag: 'plain_text', content: tip },
          text: { tag: 'plain_text', content: label },
        },
      ],
    })),
  };
}

function acknowledgedActions(
  anomalyEvent: TodayOperationsAnomalyEvent,
  recordId: string,
): Record<string, unknown> {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          {
            tag: 'button',
            type: 'default',
            width: 'fill',
            disabled: true,
            disabled_tips: {
              tag: 'plain_text',
              content: '知悉状态已记录',
            },
            text: { tag: 'plain_text', content: '已知悉' },
          },
        ],
      },
      actionColumn(
        '已处理',
        'primary_filled',
        'open_resolution',
        anomalyEvent,
        recordId,
      ),
    ],
  };
}

function detail(label: string, value: unknown): Record<string, unknown> {
  return {
    tag: 'markdown',
    content: `**${escape(label)}**\n${escape(display(value))}`,
  };
}

function metricColumn(label: string, value: string): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [detail(label, value)],
  };
}

function titleFor(anomalyEvent: TodayOperationsAnomalyEvent): string {
  return `今日航图异常 · ${anomalyEvent.anomalies.length}项待确认`;
}

function templateFor(
  anomalyEvent: TodayOperationsAnomalyEvent,
): 'orange' | 'red' {
  return anomalyEvent.anomalies.every(
    (anomaly) =>
      isScheduleConsistencyAnomaly(anomaly) || isAttendanceAnomaly(anomaly),
  )
    ? 'orange'
    : 'red';
}

function isScheduleConsistencyAnomaly(
  anomaly: TodayOperationsAnomaly,
): boolean {
  return anomaly.metricKey.startsWith('scheduleConsistency.');
}

function isAttendanceAnomaly(anomaly: TodayOperationsAnomaly): boolean {
  return anomaly.metricKey.startsWith('attendance.');
}

function categoryLabel(category: TodayOperationsAnomaly['category']): string {
  if (category === 'missing') return '数据缺失';
  return category === 'increase' ? '异常上涨' : '异常下降';
}

function display(value: unknown): string {
  const normalized = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? Array.from(normalized).slice(0, 500).join('') : '未提供';
}

function displayNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : String(value);
}

function escape(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>!|~()]/gu, '\\$&');
}

function formatShanghai(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return display(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function validate(
  anomalyEvent: TodayOperationsAnomalyEvent,
  recordId: string,
): void {
  if (!EVENT_ID_PATTERN.test(anomalyEvent.anomalyEventId)) {
    throw new Error('异常事件标识无效');
  }
  if (!anomalyEvent.anomalies.length) throw new Error('异常事件不能为空');
  if (
    anomalyEvent.anomalies.some(
      (anomaly) =>
        !EVENT_ID_PATTERN.test(anomaly.anomalyId) ||
        anomaly.businessDate !== anomalyEvent.businessDate,
    )
  ) {
    throw new Error('异常事件明细无效');
  }
  if (!RECORD_ID_PATTERN.test(recordId)) {
    throw new Error('多维表记录标识无效');
  }
}
