import type {
  DailyOperationsPatrolCheckResult,
  DailyOperationsPatrolReport,
} from './daily-operations-patrol.types';

const MAX_EXPANDED_ISSUES = 8;

export interface DailyOperationsPatrolCardOptions {
  dashboardUrl?: string;
  scheduleUrl?: string;
  followUpUrl?: string;
}

export function buildDailyOperationsPatrolCard(
  report: DailyOperationsPatrolReport,
  options: DailyOperationsPatrolCardOptions = {},
): Record<string, unknown> {
  const issueCount = report.checks.reduce((sum, check) => sum + check.count, 0);
  const hasAlerts = issueCount > 0;
  const issues = report.checks.flatMap((check) => check.issues);
  const visibleIssues = issues.slice(0, MAX_EXPANDED_ISSUES);
  const remaining = Math.max(0, issues.length - visibleIssues.length);
  const actionElements = buildActions(options);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: [
        `**巡视日期**  ${escapeMarkdown(report.businessDate)}`,
        `**巡视范围**  ${escapeMarkdown(report.startDate)} 至 ${escapeMarkdown(report.endDate)}`,
        `**总体结果**  ${hasAlerts ? `<font color="red">发现 ${issueCount} 项需关注</font>` : '<font color="green">未发现异常</font>'}`,
      ].join('\n'),
    },
    { tag: 'hr' },
    ...report.checks.map(buildCheckRow),
  ];

  if (hasAlerts) {
    elements.push(
      { tag: 'hr' },
      { tag: 'markdown', content: '**重点关注**' },
      {
        tag: 'markdown',
        content: [
          ...visibleIssues.map(
            (item, index) =>
              `${index + 1}. **${escapeMarkdown(item.title)}**${item.date ? ` · ${escapeMarkdown(item.date)}` : ''}\n   ${escapeMarkdown(item.detail)}`,
          ),
          ...(remaining > 0
            ? [`<font color="grey">另 ${remaining} 项请打开看板核对</font>`]
            : []),
        ].join('\n'),
      },
    );
  }

  elements.push(
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `<font color="grey">指标口径：最新完整日较前 2 个有效日均值变化达到 50% · 生成时间 ${formatShanghaiDateTime(report.generatedAt)}</font>`,
    },
    ...actionElements,
  );

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: hasAlerts ? 'red' : 'green',
      title: {
        tag: 'plain_text',
        content: hasAlerts
          ? `南通每日运维巡视同步 · 发现 ${issueCount} 项`
          : '南通每日运维巡视同步 · 正常',
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements,
    },
  };
}

function buildCheckRow(
  check: DailyOperationsPatrolCheckResult,
): Record<string, unknown> {
  const status =
    check.status === 'normal'
      ? '<font color="green">✅ 未发现异常</font>'
      : check.status === 'unavailable'
        ? `<font color="orange">⚠️ ${check.count} 项数据异常</font>`
        : `<font color="red">● ${check.count} 项需关注</font>`;
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        elements: [
          {
            tag: 'markdown',
            content: `**${escapeMarkdown(check.label)}**`,
          },
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        elements: [{ tag: 'markdown', content: status }],
      },
    ],
  };
}

function buildActions(
  options: DailyOperationsPatrolCardOptions,
): Array<Record<string, unknown>> {
  const actions = [
    button('异常跟进', options.followUpUrl, 'primary_filled'),
    button('打开南通全景看板', options.dashboardUrl, 'default'),
    button('打开南通排班', options.scheduleUrl, 'default'),
  ].filter((value): value is Record<string, unknown> => Boolean(value));
  if (!actions.length) return [];
  return [
    {
      tag: 'column_set',
      horizontal_spacing: '8px',
      columns: actions.map((action) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [action],
      })),
    },
  ];
}

function button(
  label: string,
  url: string | undefined,
  type: 'default' | 'primary_filled',
): Record<string, unknown> | null {
  const safeUrl = normalizeHttpUrl(url);
  if (!safeUrl) return null;
  return {
    tag: 'button',
    type,
    width: 'fill',
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'open_url', default_url: safeUrl }],
  };
}

function normalizeHttpUrl(value: string | undefined): string {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function escapeMarkdown(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/([\\`*_[\]()<>])/gu, '\\$1')
    .trim()
    .slice(0, 500);
}

function formatShanghaiDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}
