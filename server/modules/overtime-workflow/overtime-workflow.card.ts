import type {
  OvertimeApplicationSnapshot,
  OvertimeApprovalCardAction,
  OvertimeApprovalCardActionValue,
} from './overtime-workflow.types';

const BUSINESS_TEXT_LIMIT = 200;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;

export function buildOvertimeApprovalCard(
  snapshot: OvertimeApplicationSnapshot,
): Record<string, unknown> {
  const recordId = assertRecordId(snapshot.recordId);
  return buildCard('blue', '加班申请待审批', [
    ...buildSnapshotElements(snapshot),
    {
      tag: 'column_set',
      horizontal_spacing: '8px',
      columns: [
        actionColumn('同意', 'primary_filled', 'approve', recordId),
        actionColumn('驳回', 'danger', 'reject', recordId),
      ],
    },
  ]);
}

export function buildOvertimeApprovalResolvedCard(
  snapshot: OvertimeApplicationSnapshot,
  result: {
    action: 'approve' | 'reject';
    actorName: string;
    resolvedAt: string;
  },
): Record<string, unknown> {
  assertRecordId(snapshot.recordId);
  const approved = result.action === 'approve';
  return buildCard(
    approved ? 'green' : 'red',
    approved ? '加班申请审批通过' : '加班申请审批驳回',
    [
      ...buildSnapshotElements(snapshot),
      markdownField('处理人', result.actorName),
      markdownField('处理时间', result.resolvedAt, 80),
      markdownField('处理结果', approved ? '审批通过' : '审批驳回', 40),
      lockedApprovalChoices(),
    ],
  );
}

export function buildOvertimeApprovalHandoverCard(snapshot: OvertimeApplicationSnapshot): Record<string, unknown> {
  assertRecordId(snapshot.recordId);
  return buildCard('grey','加班审批已转交',[
    ...buildSnapshotElements(snapshot),
    markdownField('当前状态','审批已转交接任负责人，原卡片不可操作',80),
    lockedApprovalChoices(),
  ]);
}

export function buildOvertimeConfirmationCard(
  snapshot: OvertimeApplicationSnapshot,
  confirmationUrl: string,
): Record<string, unknown> {
  assertRecordId(snapshot.recordId);
  const safeUrl = assertConfirmationUrl(confirmationUrl);
  return buildCard('orange', '加班信息待确认', [
    buildConfirmationSnapshotSummary(snapshot),
    {
      tag: 'button',
      type: 'primary',
      width: 'fill',
      text: { tag: 'plain_text', content: '确认加班信息' },
      behaviors: [{ type: 'open_url', default_url: safeUrl }],
    },
  ]);
}

export function buildOvertimeConfirmationHandoverCard(snapshot: OvertimeApplicationSnapshot): Record<string, unknown> {
  assertRecordId(snapshot.recordId);
  return buildCard('grey', '加班确认已转交', [
    buildConfirmationSnapshotSummary(snapshot),
    markdownField('当前状态', '确认已转交接任负责人，原入口已失效', 80),
  ]);
}

export function buildOvertimeConfirmationResolvedCard(
  snapshot: OvertimeApplicationSnapshot,
  result: {
    actualStartAt: string;
    actualEndAt: string;
    actualHours: number;
    disposition: string | null;
    confirmedAt: string;
    confirmedBy: string;
  },
): Record<string, unknown> {
  assertRecordId(snapshot.recordId);
  const cancelled = result.actualHours === 0;
  const confirmedBy = assertRequiredDisplayText(
    result.confirmedBy,
    '加班确认处理人',
    80,
  );
  const disposition = cancelled
    ? null
    : assertRequiredDisplayText(result.disposition, '加班确认工时处置', 80);
  return buildCard(
    cancelled ? 'grey' : 'blue',
    cancelled ? '加班已取消' : '加班信息已确认',
    buildConfirmationResultElements(
      snapshot,
      { ...result, confirmedBy, disposition },
      cancelled,
    ),
  );
}

export function buildOvertimeSourceDeletedCard(
  snapshot: OvertimeApplicationSnapshot,
): Record<string, unknown> {
  assertRecordId(snapshot.recordId);
  return buildCard('grey', '加班申请已撤销', [
    buildConfirmationSnapshotSummary(snapshot),
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          "**底表记录已删除**\n<font color='grey'>审批和确认已终止，不再提醒</font>",
      },
    },
  ]);
}

function buildCard(
  template: 'blue' | 'green' | 'grey' | 'orange' | 'red',
  title: string,
  elements: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements,
    },
  };
}

function buildConfirmationSnapshotSummary(
  snapshot: OvertimeApplicationSnapshot,
): Record<string, unknown> {
  return {
    tag: 'div',
    text: compactIdentity(snapshot),
    fields: [
      compactMetricField(
        '计划时段',
        formatTimeRange(snapshot.plannedStartAt, snapshot.plannedEndAt),
        false,
      ),
      compactMetricField(
        '申请工时',
        `${formatHours(snapshot.plannedHours)} 小时`,
      ),
      compactMetricField('加班原因', snapshot.reason, false),
    ],
  };
}

function buildConfirmationResultElements(
  snapshot: OvertimeApplicationSnapshot,
  result: {
    actualStartAt: string;
    actualEndAt: string;
    actualHours: number;
    disposition: string | null;
    confirmedAt: string;
    confirmedBy: string;
  },
  cancelled: boolean,
): Array<Record<string, unknown>> {
  const plannedRange = formatTimeRange(
    snapshot.plannedStartAt,
    snapshot.plannedEndAt,
  );
  const actualRange = cancelled
    ? null
    : formatTimeRange(result.actualStartAt, result.actualEndAt);
  const timeLines = [`**计划时段**\n${escapeMarkdown(plannedRange)}`];
  if (cancelled) {
    timeLines.push("<font color='grey'>实际结果：未实际发生</font>");
  } else if (actualRange !== plannedRange) {
    timeLines.push(`**实际时段**\n${escapeMarkdown(actualRange)}`);
  }

  const reason = normalizeOptionalBusinessText(snapshot.reason, 200);
  const confirmedAt = formatOptionalCompactDateTime(result.confirmedAt);
  const metadata = [`处理人：${escapeMarkdown(result.confirmedBy)}`];
  if (confirmedAt) {
    metadata.push(`确认时间：${escapeMarkdown(confirmedAt)}`);
  }
  const detailLines = reason
    ? [
        `**加班原因**\n${escapeMarkdown(reason)}`,
        `<font color='grey'>${metadata.join('　')}</font>`,
      ]
    : [`<font color='grey'>${metadata.join('　')}</font>`];

  return [
    {
      tag: 'div',
      text: compactResolvedIdentity(snapshot),
    },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: timeLines.join('\n'),
      },
    },
    {
      tag: 'div',
      fields: [
        compactMetricField(
          '确认工时',
          `${formatHours(result.actualHours)} 小时`,
        ),
        compactMetricField(
          '工时处置',
          cancelled ? '无需处置' : result.disposition,
        ),
      ],
    },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: detailLines.join('\n'),
      },
    },
  ];
}

function compactResolvedIdentity(
  snapshot: OvertimeApplicationSnapshot,
): Record<string, unknown> {
  const applicantName = escapeMarkdown(
    normalizeBusinessText(snapshot.applicantName, 60),
  );
  const identityDetails = [
    normalizeOptionalBusinessText(snapshot.building, 40),
    normalizeOptionalBusinessText(snapshot.position, 60),
  ]
    .filter(Boolean)
    .map(escapeMarkdown);
  return {
    tag: 'lark_md',
    content: identityDetails.length
      ? `**${applicantName}**\u3000<font color='grey'>${identityDetails.join(' / ')}</font>`
      : `**${applicantName}**`,
  };
}

function compactIdentity(
  snapshot: OvertimeApplicationSnapshot,
): Record<string, unknown> {
  const applicantName = escapeMarkdown(
    normalizeBusinessText(snapshot.applicantName, 60),
  );
  const building = escapeMarkdown(normalizeBusinessText(snapshot.building, 40));
  const position = escapeMarkdown(normalizeBusinessText(snapshot.position, 60));
  return {
    tag: 'lark_md',
    content: `**${applicantName}**\u3000<font color='grey'>${building} / ${position}</font>`,
  };
}

function compactMetricField(
  label: string,
  value: unknown,
  isShort = true,
): Record<string, unknown> {
  const safeLabel = escapeMarkdown(normalizeBusinessText(label, 40));
  const safeValue = escapeMarkdown(normalizeBusinessText(value, 200));
  return {
    is_short: isShort,
    text: {
      tag: 'lark_md',
      content: `**${safeValue}**\n<font color='grey'>${safeLabel}</font>`,
    },
  };
}

function formatTimeRange(startAt: unknown, endAt: unknown): string {
  return `${formatCompactDateTime(startAt)} → ${formatCompactDateTime(endAt)}`;
}

function formatCompactDateTime(value: unknown): string {
  return formatOptionalCompactDateTime(value) || '未提供';
}

function formatOptionalCompactDateTime(value: unknown): string {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? formatShanghaiDate(value) : '';
  }
  const normalized = normalizeOptionalBusinessText(value, 80);
  if (!normalized) return '';

  if (/(?:Z|[+-]\d{2}:\d{2})$/iu.test(normalized)) {
    const parsed = new Date(normalized);
    if (Number.isFinite(parsed.getTime())) return formatShanghaiDate(parsed);
  }

  const match = normalized.match(
    /^\d{4}[-/](\d{1,2})[-/](\d{1,2})[T\s](\d{1,2}):(\d{2})/u,
  );
  if (!match) {
    return normalized
      .replace(/T(?=\d{2}:\d{2})/u, ' ')
      .replace(/(?:Z|[+-]\d{2}:\d{2})$/iu, '');
  }
  return `${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')} ${match[3].padStart(2, '0')}:${match[4]}`;
}

function formatShanghaiDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`;
}

function buildSnapshotElements(
  snapshot: OvertimeApplicationSnapshot,
): Array<Record<string, unknown>> {
  return [
    markdownField('申请人', snapshot.applicantName),
    markdownField(
      '楼栋 / 岗位',
      `${normalizeBusinessText(snapshot.building, 40)} / ${normalizeBusinessText(
        snapshot.position,
        60,
      )}`,
    ),
    markdownField('计划开始', snapshot.plannedStartAt, 80),
    markdownField('计划结束', snapshot.plannedEndAt, 80),
    markdownField('申请工时', `${formatHours(snapshot.plannedHours)} 小时`, 40),
    markdownField('加班原因', snapshot.reason),
  ];
}

function markdownField(
  label: string,
  value: unknown,
  limit = BUSINESS_TEXT_LIMIT,
): Record<string, unknown> {
  const normalized = normalizeBusinessText(value, limit);
  return {
    tag: 'markdown',
    content: `**${label}**\n${escapeMarkdown(normalized)}`,
  };
}

function actionColumn(
  label: string,
  type: 'primary_filled' | 'danger',
  action: OvertimeApprovalCardAction,
  recordId: string,
): Record<string, unknown> {
  const value: OvertimeApprovalCardActionValue = {
    version: 1,
    action,
    recordId,
  };
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'button',
        type,
        width: 'fill',
        text: { tag: 'plain_text', content: label },
        behaviors: [{ type: 'callback', value }],
      },
    ],
  };
}

function lockedApprovalChoices(): Record<string, unknown> {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: ['同意', '驳回'].map((label) => ({
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
            content: '该申请已处理',
          },
          text: { tag: 'plain_text', content: label },
        },
      ],
    })),
  };
}

function formatHours(value: number): string {
  return Number.isFinite(value) && value >= 0
    ? Number(value.toFixed(2)).toString()
    : '未提供';
}

function normalizeBusinessText(value: unknown, limit: number): string {
  return normalizeOptionalBusinessText(value, limit) || '未提供';
}

function normalizeOptionalBusinessText(value: unknown, limit: number): string {
  const source =
    value instanceof Date
      ? Number.isFinite(value.getTime())
        ? value.toISOString()
        : ''
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
  const normalized = source
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return '';
  const characters = Array.from(normalized);
  return characters.length <= limit
    ? normalized
    : `${characters.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

function assertRequiredDisplayText(
  value: unknown,
  label: string,
  limit: number,
): string {
  const normalized = normalizeBusinessText(value, limit);
  if (normalized === '未提供') {
    throw new Error(`${label}不能为空`);
  }
  return normalized;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_{}\[\]<>!|~()]/gu, '\\$&')
    .replace(/^[#>+\-]/u, '\\$&');
}

function assertRecordId(value: unknown): string {
  if (typeof value !== 'string' || !RECORD_ID_PATTERN.test(value)) {
    throw new Error('加班记录标识无效');
  }
  return value;
}

function assertConfirmationUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_000) {
    throw new Error('加班确认链接无效');
  }
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const isLoopbackHttp =
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
    if (
      !(parsed.protocol === 'https:' || isLoopbackHttp) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('加班确认链接无效');
  }
  return value;
}
