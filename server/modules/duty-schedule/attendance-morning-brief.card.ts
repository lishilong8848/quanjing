import type {
  AttendanceAnomalyCard,
  AttendanceSummarySection,
} from './attendance-automation.card';
import type { DailyOperationsPatrolReport } from './daily-operations-patrol.types';
import type { TrainingParticipation } from '../../../shared/campus-training-dashboard.interface';
import { buildFollowUpEntryButton } from '../bitable-sync/today-operations-follow-up-card';

export interface AttendanceMorningBriefInput {
  reportDate: string;
  fetchedAt: string;
  sections: AttendanceSummarySection[];
  patrol: DailyOperationsPatrolReport | null;
  trainingParticipation?: TrainingParticipation[];
  archiveRecordCount?: number;
  scheduleUrl: string;
  dashboardUrl: string;
  followUpCardId?: string;
  attendanceUnavailableReason?: string;
  alarmTagAnomalies?: { date: string; count: number; detailsUrl: string };
  alarmTagsUnavailable?: boolean;
}

export function buildAttendanceMorningBrief(
  input: AttendanceMorningBriefInput,
): AttendanceAnomalyCard {
  const anomalyCount = input.sections.reduce(
    (total, section) => total + section.anomalies.length,
    0,
  );
  const capacityWarning =
    typeof input.archiveRecordCount === 'number' &&
    input.archiveRecordCount >= 40_000;
  const unavailable =
    Boolean(input.alarmTagsUnavailable) ||
    Boolean(input.attendanceUnavailableReason) ||
    !input.patrol ||
    input.patrol.checks.some((check) => check.status === 'unavailable');
  const summary: CardElements = [
    {
      tag: 'markdown',
      text_size: 'heading-3',
      content: `**考勤${input.attendanceUnavailableReason ? '待核验' : `异常 ${anomalyCount} 项`}　｜　巡视${input.patrol ? `关注 ${input.patrol.totalIssues} 项` : '待核验'}**`,
    },
    {
      tag: 'markdown',
      content: `<font color="grey">09:30 简报 · ${input.attendanceUnavailableReason ? `考勤：${plain(input.attendanceUnavailableReason)}` : `考勤截至 ${plain(input.fetchedAt)}`}</font>`,
    },
  ];
  const elements: AttendanceAnomalyCard['body']['elements'] = [
    block(summary, true),
  ];
  if (capacityWarning)
    elements.push(
      block(
        [
          {
            tag: 'markdown',
            content: `**<font color="orange">考勤表已达 ${input.archiveRecordCount!.toLocaleString('en-US')} 条，请备份</font>**\n导出核验后再清理，不自动删除历史。`,
          },
        ],
        true,
      ),
    );
  const attendance: CardElements = [];
  if (input.attendanceUnavailableReason) {
    attendance.push({
      tag: 'markdown',
      content: `**考勤数据暂不可用**\n<font color="orange">${plain(input.attendanceUnavailableReason)}</font>，请在排班页核查；系统仍会按有限次数自动重试。`,
    });
  }
  for (const section of input.attendanceUnavailableReason
    ? []
    : input.sections) {
    const groups = new Map<string, Map<string, string[]>>();
    for (const item of section.anomalies.slice(0, 60)) {
      if (!groups.has(item.building)) groups.set(item.building, new Map());
      const people = groups.get(item.building)!;
      if (!people.has(item.name)) people.set(item.name, []);
      people
        .get(item.name)!
        .push(
          `${/加班/.test(item.shiftLabel) ? `加班 ${plain(item.expectedAt.slice(11, 16))} ` : ''}<text_tag color="${item.direction === 'OnDuty' ? 'blue' : 'neutral'}">${item.direction === 'OnDuty' ? '上班' : '下班'}</text_tag> ${plain(item.reason)}`,
        );
    }
    const status = section.anomalies.length
      ? `<font color="orange">异常 ${section.anomalies.length} 项</font>`
      : section.normalCount
        ? `<font color="green">无异常 · 正常 ${section.normalCount} 项</font>`
        : '<font color="grey">暂无核验记录</font>';
    attendance.push({
      tag: 'markdown',
      content: [
        `**${section.title} · ${plain(section.date)}**　${status}`,
        ...[...groups]
          .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
          .map(
            ([building, people]) =>
              `**${plain(building)}**　${[...people].map(([name, items]) => `${plain(name)} ${[...new Set(items)].join(' / ')}`).join('；')}`,
          ),
        ...(section.anomalies.length > 60
          ? [`另 ${section.anomalies.length - 60} 项，请查看排班页面`]
          : []),
      ].join('\n'),
    });
  }
  if (!input.attendanceUnavailableReason && !input.sections.length)
    attendance.push({ tag: 'markdown', content: '考勤：暂无核验记录' });
  elements.push(block(attendance));
  const patrol: CardElements = [];
  if (!input.patrol)
    patrol.push({
      tag: 'markdown',
      content:
        '<font color="orange">巡视数据暂不可用，请稍后在全景看板核查</font>',
    });
  else {
    const normal = input.patrol.checks.filter(
      (check) => check.status === 'normal',
    );
    patrol.push({
      tag: 'markdown',
      content: `**运维巡视 · ${plain(input.patrol.startDate)} 至 ${plain(input.patrol.endDate)}**${normal.length ? `\n<font color="green">${normal.map((check) => plain(check.label)).join(' / ')}：正常</font>` : ''}`,
    });
    for (const check of input.patrol.checks.filter(
      (check) => check.status !== 'normal',
    )) {
      patrol.push({
        tag: 'markdown',
        content: [
          `**${plain(check.label)}**　<font color="orange">${check.status === 'unavailable' ? '数据待核验' : `${check.count} 项关注`}</font>`,
          ...check.issues
            .slice(0, 4)
            .map(
              (issue) =>
                `${plain(issue.date)} · ${plain(issue.title)}：${plain(issue.detail).slice(0, 240)}`,
            ),
          ...(check.issues.length > 4
            ? [`另 ${check.issues.length - 4} 项，请查看全景看板`]
            : []),
        ].join('\n'),
      });
    }
  }
  elements.push(block(patrol, true));
  const alarmTags = input.alarmTagAnomalies;
  if (alarmTags && alarmTags.count > 0) {
    if (!Number.isSafeInteger(alarmTags.count) || !/^https?:\/\//i.test(alarmTags.detailsUrl))
      throw new Error('昨日告警异常统计或链接无效');
    elements.push(block([
      {
        tag: 'markdown',
        content: `**告警异常 · ${plain(alarmTags.date)}**\n<font color="orange">昨日告警异常打标 ${alarmTags.count} 项，需要跟踪处理</font>`,
      },
      {
        tag: 'button', type: 'default', width: 'fill',
        text: { tag: 'plain_text', content: '查看告警异常' },
        behaviors: [{ type: 'open_url', default_url: alarmTags.detailsUrl }],
      },
    ], true));
  } else if (input.alarmTagsUnavailable) {
    elements.push(block([{ tag: 'markdown', content: '<font color="orange">昨日告警打标数据暂不可用，请稍后核查</font>' }], true));
  }
  if (Number(input.reportDate.slice(8, 10)) >= 25) {
    const incomplete = (input.trainingParticipation || []).filter(
      (item) =>
        item.assessmentPassRate !== null && item.assessmentPassRate < 100,
    );
    if (incomplete.length) {
      elements.push(
        block(
          [
            {
              tag: 'markdown',
              content: [
                `**月度培训进展 · ${plain(input.reportDate.slice(0, 7))}**`,
                ...incomplete.map(
                  (item) =>
                    `**${plain(item.building)}**　培训 ${formatTrainingRate(item.trainingCompletionRate)}%　考核 ${formatTrainingRate(item.assessmentPassRate!)}%`,
                ),
              ].join('\n'),
            },
          ],
          true,
        ),
      );
    }
  }
  const actions: CardElements = [];
  if (input.followUpCardId) actions.push(buildFollowUpEntryButton(input.followUpCardId));
  for (const [label, url] of [
    ['查看实际排班', input.scheduleUrl],
    ['查看全景看板', input.dashboardUrl],
  ]) {
    if (!/^https?:\/\//i.test(url)) throw new Error('每日简报链接无效');
    actions.push({
      tag: 'button',
      type: 'default',
      width: 'fill',
      text: { tag: 'plain_text', content: label },
      behaviors: [{ type: 'open_url', default_url: url }],
    });
  }
  elements.push(block(actions));
  const card: AttendanceAnomalyCard = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
    },
    header: {
      template:
        anomalyCount ||
        (alarmTags?.count || 0) ||
        capacityWarning ||
        unavailable ||
        input.patrol?.hasAlerts
          ? 'orange'
          : 'green',
      title: {
        tag: 'plain_text',
        content: `南通每日运维巡视同步 · ${input.reportDate}`,
      },
      icon: { tag: 'standard_icon', token: 'warning_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '12px',
      elements,
    },
  };
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 30 * 1024)
    throw new Error('每日简报超过消息大小限制，未发送截断数据');
  return card;
}

type CardBlock = Extract<
  AttendanceAnomalyCard['body']['elements'][number],
  { tag: 'column_set' }
>;
type CardElements = CardBlock['columns'][0]['elements'];

function block(elements: CardElements, shaded = false): CardBlock {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        direction: 'vertical',
        vertical_spacing: '8px',
        padding: shaded ? '8px' : '0px',
        ...(shaded ? { background_style: 'grey-50' } : {}),
        elements,
      },
    ],
  };
}

function plain(value: string): string {
  return String(value || '')
    .replace(/[<>*_`\[\]\\]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

function formatTrainingRate(value: number): string {
  return String(Number(value.toFixed(1)));
}
