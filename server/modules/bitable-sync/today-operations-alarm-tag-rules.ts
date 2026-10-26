import type { TodayOperationsAlarmTagIssue } from '../../../shared/today-operations-alarm.interface';

export const OFFICIAL_ALARM_TAGS = [
  '变更',
  '维护',
  '检修',
  '设备轮巡',
  '上下电',
  '设备故障',
  '人为误操作',
  '通讯故障',
  '超电',
  '环境参数异常',
  '未知原因',
  '低负荷',
  '设备调整',
] as const;

const officialTagSet = new Set<string>(OFFICIAL_ALARM_TAGS);
const placeholderPattern = /TODO|待填|占位|\bnull\b|\bnone\b|xxxx|[？?]{2,}/iu;
const fillerPatterns = [
  /已联系厂家维修/gu,
  /已(?:通知|反馈|告知)工程师(?:处理|检修|维修)?/gu,
  /已反馈处理/gu,
  /(?:运维人员|值班人员|值机人员|人员|工程师)(?:已|去|前往|到|赶往)+现场(?:查看|确认|检查|处理)?/gu,
  /现场(?:查看|确认|检查|核实)(?:完成|完毕)?/gu,
  /人员已到现场/gu,
  /告警已?复位|告警已?恢复|告警恢复|已恢复(?:正常)?|恢复正常/gu,
  /已处理(?:完成|完毕)?|处理(?:完成|完毕)/gu,
  /后期加强关注|加强关注|加强监视/gu,
  /产生的告警|引起的告警|造成的告警|所致/gu,
  /[。,，;；！!、\s]+/gu,
];

export interface AlarmTagRuleInput {
  processingStatus: string;
  acceptanceDescription: string;
  confirmationDescription: string;
}

export function readAlarmTag(description: string): string | null {
  return /^【([^】]+)】/u.exec(description.trim())?.[1]?.trim() || null;
}

function deviceFaultBody(description: string): string {
  let body = description.trim().replace(/^【[^】]+】\s*/u, '');
  let previous: string;
  do {
    previous = body;
    for (const pattern of fillerPatterns) body = body.replace(pattern, '');
  } while (body !== previous);
  return body.trim();
}

function isVagueDeviceFault(description: string): boolean {
  const body = deviceFaultBody(description);
  return !body || /^(?:设备|系统)?故障$/u.test(body);
}

function statesDeviceFaultCause(description: string): boolean {
  const body = deviceFaultBody(description);
  return !isVagueDeviceFault(description) &&
    /故障|失效|损坏|断路|短路|卡滞|漏电|泄漏/u.test(body);
}

export function detectAlarmTagRuleIssues(
  input: AlarmTagRuleInput,
): TodayOperationsAlarmTagIssue[] {
  const issues: TodayOperationsAlarmTagIssue[] = [];
  const sides = [
    {
      side: 'acceptance' as const,
      label: '受理描述',
      text: input.acceptanceDescription.trim(),
    },
    {
      side: 'confirmation' as const,
      label: '确认描述',
      text: input.confirmationDescription.trim(),
    },
  ];
  const hasDescribedDeviceFault = sides.some(
    ({ text }) =>
      readAlarmTag(text) === '设备故障' && statesDeviceFaultCause(text),
  );

  for (const { side, label, text } of sides) {
    if (!text) {
      if (
        input.processingStatus === '已处理' ||
        input.processingStatus === '处理中'
      ) {
        issues.push({
          code: 'missing',
          side,
          label: '描述漏填',
          reason: `${label}为空，当前处理状态为${input.processingStatus}`,
          source: 'rule',
        });
      }
      continue;
    }

    const tag = readAlarmTag(text);
    const formatReasons: string[] = [];
    if (!tag) formatReasons.push('未以完整的【分类标签】开头');
    if (placeholderPattern.test(text)) formatReasons.push('包含待填或占位内容');
    if (formatReasons.length) {
      issues.push({
        code: 'format',
        side,
        label: '描述格式异常',
        reason: `${label}${formatReasons.join('，')}`,
        source: 'rule',
      });
    }
    if (!tag) continue;

    if (!officialTagSet.has(tag)) {
      const suggestedTag =
        tag === '设备检修'
          ? '检修'
          : tag === '通信故障'
            ? '通讯故障'
            : undefined;
      issues.push({
        code: 'nonOfficial',
        side,
        label: '非官方标签',
        reason: `${label}使用了非官方标签【${tag}】`,
        source: 'rule',
        ...(suggestedTag ? { suggestedTag } : {}),
      });
    }
    if (
      tag === '设备故障' &&
      !hasDescribedDeviceFault &&
      isVagueDeviceFault(text)
    ) {
      issues.push({
        code: 'vague',
        side,
        label: '设备故障未说明原因',
        reason: `${label}去除处理套话后未留下设备或故障说明`,
        source: 'rule',
      });
    }
  }

  if (
    readAlarmTag(input.acceptanceDescription) === '检修' &&
    readAlarmTag(input.confirmationDescription) === '变更'
  ) {
    issues.push({
      code: 'pending',
      side: 'both',
      label: '检修/变更待确认',
      reason: '受理标为【检修】，确认改为【变更】，需人工核对受理阶段的分类',
      source: 'rule',
    });
  }
  return issues;
}
