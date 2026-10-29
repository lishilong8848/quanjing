import type { AttendanceAnomaly } from './attendance-automation.rules';

export interface AttendanceAnomalyCardInput {
  date: string;
  fetchedAt: string;
  label?: string;
  summaryPeriod?: 'today' | 'yesterday';
  dueSlots: string[];
  futureSlots: string[];
  anomalies: AttendanceAnomaly[];
  normalCount: number;
  excludedCount?: number;
  scheduleUrl: string;
}

export interface PersonalAttendanceAnomalyCardInput {
  date: string;
  fetchedAt: string;
  label: string;
  recipientName: string;
  anomalies: AttendanceAnomaly[];
  dingTalkCorrectionUrl: string;
  leaveRequestUrl: string;
  scheduleUrl: string;
}

export interface AttendanceSummarySection {
  title: '今日白班' | '昨日白班' | '昨日夜班';
  date: string;
  anomalies: AttendanceAnomaly[];
  normalCount: number;
}

export interface AttendanceDailySummaryCardInput {
  reportDate: string;
  fetchedAt: string;
  label: string;
  sections: AttendanceSummarySection[];
  scheduleUrl: string;
}

interface AttendanceCardMarkdown {
  tag: 'markdown';
  content: string;
  text_size?: 'heading-3' | 'normal' | 'notation';
}

interface AttendanceCardButton {
  tag: 'button';
  type: 'primary_filled' | 'default';
  width: 'fill';
  text: { tag: 'plain_text'; content: string };
  behaviors: [{ type: 'open_url'; default_url: string } | { type: 'callback'; value: Record<string, unknown> }];
}

interface AttendanceCardButtonGroup {
  tag: 'column_set';
  flex_mode: 'none';
  columns: [
    {
      tag: 'column';
      width: 'weighted';
      weight: 1;
      direction: 'vertical';
      vertical_spacing: '8px';
      padding?: string;
      background_style?: string;
      elements: Array<AttendanceCardButton | AttendanceCardMarkdown>;
    },
  ];
}

export interface AttendanceAnomalyCard {
  schema: '2.0';
  config: {
    update_multi: true;
    width_mode: 'default';
    enable_forward: false;
  };
  header: {
    template: 'orange' | 'green';
    title: { tag: 'plain_text'; content: string };
    icon: { tag: 'standard_icon'; token: 'warning_colorful' };
  };
  body: {
    direction: 'vertical';
    padding: string;
    vertical_spacing: '12px';
    elements: Array<
      AttendanceCardMarkdown | AttendanceCardButton | AttendanceCardButtonGroup
    >;
  };
}

export function buildAttendanceAnomalyCard(
  input: AttendanceAnomalyCardInput,
): AttendanceAnomalyCard {
  const titlePrefix = input.label ? `【${safePlainText(input.label)}】` : '';
  const summaryLabel =
    input.summaryPeriod === 'yesterday' ? '昨日汇总' : '今日汇总';
  const attendanceStatus = input.anomalies.length > 0 ? '考勤异常' : '考勤正常';
  const countSummary = [
    `<font color="red">● ${input.anomalies.length} 人异常</font>`,
    `<font color="green">● ${input.normalCount} 人正常</font>`,
    ...(typeof input.excludedCount === 'number'
      ? [`<font color="grey">${input.excludedCount} 人请休假排除</font>`]
      : []),
  ].join('　｜　');
  const elements: AttendanceAnomalyCard['body']['elements'] = [
    {
      tag: 'markdown',
      content: [
        `**${escapeMarkdown(input.date)}　数据截至 ${escapeMarkdown(input.fetchedAt)}**`,
        countSummary,
        `<font color="green">已核验 ${input.dueSlots.map(escapeMarkdown).join(' / ') || '无'}</font>${
          input.futureSlots.length > 0
            ? `　｜　<font color="grey">${input.futureSlots.map(escapeMarkdown).join(' / ')} 未到时间</font>`
            : ''
        }`,
      ].join('\n'),
    },
  ];

  if (input.anomalies.length > 0) {
    elements.push({
      tag: 'markdown',
      content: [
        '**<font color="red">明确异常</font>**',
        ...input.anomalies.map(
          (item) =>
            `**${escapeMarkdown(item.building)} · ${escapeMarkdown(item.name)}**　${escapeMarkdown(item.shiftLabel)}　应打 **${escapeMarkdown(item.expectedAt.slice(11, 16))}**　<font color="red">${item.direction === 'OnDuty' ? '上班' : '下班'}卡：${escapeMarkdown(item.reason)}</font>`,
        ),
      ].join('\n'),
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: '**<font color="green">本时段考勤正常</font>**',
    });
  }

  elements.push({
    tag: 'button',
    type: 'primary_filled',
    width: 'fill',
    text: { tag: 'plain_text', content: '查看实际排班' },
    behaviors: [{ type: 'open_url', default_url: input.scheduleUrl }],
  });

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
    },
    header: {
      template: input.anomalies.length > 0 ? 'orange' : 'green',
      title: {
        tag: 'plain_text',
        content: `${titlePrefix}南通园区${attendanceStatus} · ${summaryLabel}`,
      },
      icon: { tag: 'standard_icon', token: 'warning_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements,
    },
  };
}

export function buildPersonalAttendanceAnomalyCard(
  input: PersonalAttendanceAnomalyCardInput,
): AttendanceAnomalyCard {
  const elements: AttendanceAnomalyCard['body']['elements'] = [
    {
      tag: 'markdown',
      content: [
        `**${escapeMarkdown(input.recipientName)}，你有 <font color="red">${input.anomalies.length} 项考勤异常</font>**`,
        `<font color="grey">${escapeMarkdown(input.date)}　数据截至 ${escapeMarkdown(input.fetchedAt)}</font>`,
      ].join('\n'),
    },
    {
      tag: 'markdown',
      content: input.anomalies
        .map(
          (item) =>
            `**${escapeMarkdown(item.building)} · ${escapeMarkdown(item.shiftLabel)} · ${item.direction === 'OnDuty' ? '上班卡' : '下班卡'}**\n应打 **${escapeMarkdown(item.expectedAt.slice(11, 16))}**　<font color="red">${escapeMarkdown(item.reason)}</font>`,
        )
        .join('\n'),
    },
    {
      tag: 'markdown',
      content: [
        '**请及时处理**',
        '未打卡请进入钉钉后选择“补卡申请”提交。',
        '如本次未打卡是因请休假，请确认请休假申请是否已经提交。',
        '<font color="grey">已完成补卡或请休假可忽略本提醒；如排班、请休假、替班信息有误，请及时联系楼栋主管。</font>',
      ].join('\n'),
    },
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          direction: 'vertical',
          vertical_spacing: '8px',
          elements: [
            {
              tag: 'button',
              type: 'primary_filled',
              width: 'fill',
              text: { tag: 'plain_text', content: '前往钉钉补卡' },
              behaviors: [
                {
                  type: 'open_url',
                  default_url: input.dingTalkCorrectionUrl,
                },
              ],
            },
            {
              tag: 'button',
              type: 'default',
              width: 'fill',
              text: { tag: 'plain_text', content: '补提请休假' },
              behaviors: [
                { type: 'open_url', default_url: input.leaveRequestUrl },
              ],
            },
            {
              tag: 'button',
              type: 'default',
              width: 'fill',
              text: { tag: 'plain_text', content: '查看实际排班' },
              behaviors: [{ type: 'open_url', default_url: input.scheduleUrl }],
            },
          ],
        },
      ],
    },
  ];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: `【${safePlainText(input.label)}】考勤异常提醒`,
      },
      icon: { tag: 'standard_icon', token: 'warning_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements,
    },
  };
}

export function buildAttendanceDailySummaryCard(
  input: AttendanceDailySummaryCardInput,
): AttendanceAnomalyCard {
  const anomalyCount = input.sections.reduce(
    (total, section) => total + section.anomalies.length,
    0,
  );
  const elements: AttendanceAnomalyCard['body']['elements'] = [
    {
      tag: 'markdown',
      content: `**汇总日期 ${escapeMarkdown(input.reportDate)}**　<font color="grey">数据截至 ${escapeMarkdown(input.fetchedAt)}</font>`,
    },
    ...input.sections.map((section): AttendanceCardMarkdown => {
      const expected = section.normalCount + section.anomalies.length;
      const summary =
        expected === 0
          ? '<font color="grey">无应核验人员</font>'
          : [
              `<font color="${section.anomalies.length > 0 ? 'red' : 'green'}">${section.anomalies.length > 0 ? `异常 ${section.anomalies.length} 项` : '无异常'}</font>`,
              `<font color="green">正常 ${section.normalCount} 项</font>`,
            ].join('　｜　');
      const details = section.anomalies.map(
        (item) =>
          `**${escapeMarkdown(item.building)} · ${escapeMarkdown(item.name)}**　${item.direction === 'OnDuty' ? '上班卡' : '下班卡'}　<font color="red">${escapeMarkdown(item.reason)}</font>`,
      );
      return {
        tag: 'markdown',
        content: [
          `**${section.title} · ${escapeMarkdown(section.date)}**`,
          summary,
          ...details,
        ].join('\n'),
      };
    }),
    {
      tag: 'button',
      type: 'primary_filled',
      width: 'fill',
      text: { tag: 'plain_text', content: '查看实际排班' },
      behaviors: [{ type: 'open_url', default_url: input.scheduleUrl }],
    },
  ];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
    },
    header: {
      template: anomalyCount > 0 ? 'orange' : 'green',
      title: {
        tag: 'plain_text',
        content: `【${safePlainText(input.label)}】南通园区考勤${anomalyCount > 0 ? '异常' : '正常'} · ${safePlainText(input.reportDate)}`,
      },
      icon: { tag: 'standard_icon', token: 'warning_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements,
    },
  };
}

function safePlainText(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
}

function escapeMarkdown(value: string): string {
  return String(value)
    .replaceAll('&', '&#38;')
    .replaceAll('<', '&#60;')
    .replaceAll('>', '&#62;')
    .replaceAll('*', '&#42;')
    .replaceAll('_', '&#95;')
    .replace(/[\r\n]/g, ' ')
    .trim();
}
