import type {
  MeetingNature,
  MeetingScope,
} from '../../../../shared/meeting-management.interface';
export interface DemoMeeting {
  id: string;
  isDemo: true;
  title: string;
  date: string;
  scope: MeetingScope;
  nature: MeetingNature;
  topic: string;
  owner: string;
  summary: string;
  hasMinutes: boolean;
  actions: { subject: string; owner: string; closed: boolean }[];
}
const THEMES: Record<
  Exclude<MeetingScope, '运维部' | '未分类'>,
  { title: string; owner: string; topic: string; summary: string }[]
> = {
  机房: [
    {
      title: '供配电可靠性专项会',
      owner: '电气专业组',
      topic: '设施可靠性',
      summary: '复盘供配电风险，核对维保计划与应急备件，明确现场验证事项。',
    },
    {
      title: '制冷系统节能复盘',
      owner: '暖通专业组',
      topic: '能效提升',
      summary: '围绕制冷运行策略、季节切换和负载变化，形成能效改进清单。',
    },
    {
      title: '属地运维协同会',
      owner: '南通运营组',
      topic: '运维协同',
      summary: '对齐各楼栋工作安排，跟进跨专业接口与属地资源需求。',
    },
  ],
  客户: [
    {
      title: '客户服务与SLA沟通会',
      owner: '客户服务组',
      topic: '客户交付',
      summary: '同步服务需求、变更窗口与交付计划，确认客户反馈和响应安排。',
    },
    {
      title: '客户专项需求评审',
      owner: '客户服务组',
      topic: '客户交付',
      summary: '梳理新增需求和交付边界，评估资源与技术方案，明确沟通节点。',
    },
  ],
  区域: [
    {
      title: '区域风险与资源协同会',
      owner: '区域运营组',
      topic: '风险治理',
      summary: '梳理区域共性风险、人员资源和跨基地协作事项，明确推动路径。',
    },
    {
      title: '区域技术经验交流',
      owner: '区域技术组',
      topic: '能力建设',
      summary: '分享设备故障案例与巡检经验，沉淀可复用的排查方法。',
    },
  ],
  总部: [
    {
      title: '总部质量与标准推进会',
      owner: '总部质量组',
      topic: '标准建设',
      summary: '对齐质量要求和制度更新，评估基地执行进展，跟进标准化交付。',
    },
    {
      title: '总部运营管理复盘',
      owner: '总部运营组',
      topic: '风险治理',
      summary: '回顾运营目标与专项推进情况，明确下阶段管理重点。',
    },
  ],
};
const SCOPES: Exclude<MeetingScope, '运维部' | '未分类'>[] = [
  '机房',
  '客户',
  '机房',
  '区域',
  '总部',
  '机房',
  '客户',
  '区域',
  '机房',
  '总部',
];
const MONTHS = [
  ['2026-05', 9],
  ['2026-06', 12],
  ['2026-07', 10],
  ['2026-08', 15],
  ['2026-09', 14],
  ['2026-10', 8],
] as const;
let sequence = 0;
export const DEMO_MEETINGS: DemoMeeting[] = MONTHS.flatMap(
  ([month, count], monthIndex) =>
    Array.from({ length: count }, (_, index) => {
      const seq = sequence++;
      const scope = SCOPES[(index + monthIndex) % SCOPES.length];
      const themes = THEMES[scope];
      const theme = themes[(index + monthIndex) % themes.length];
      const nature: MeetingNature =
        seq % 7 === 0 ? '培训类' : seq % 3 === 0 ? '专业类' : '管理类';
      const day =
        month === '2026-10' ? 1 + (index % 7) : 1 + ((index * 3) % 27);
      return {
        ...theme,
        id: `demo-meeting-${seq}`,
        isDemo: true as const,
        date: `${month}-${String(day).padStart(2, '0')}`,
        nature,
        scope,
        title: nature === '培训类' ? `${theme.topic}专题培训` : theme.title,
        hasMinutes: seq % 6 !== 0,
        actions: Array.from({ length: 2 + (seq % 4) }, (_, action) => ({
          subject: [
            `完善${theme.topic}事项清单与责任分工`,
            `复核${theme.topic}相关方案并反馈执行情况`,
            `整理会议案例与交付材料`,
            `跟进跨部门协作与资源需求`,
            `完成专题验证并记录复盘结果`,
          ][action],
          owner: theme.owner,
          closed: (seq + action) % 5 !== 0,
        })),
      };
    }),
).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

export function selectDemoMeetings(
  records: DemoMeeting[],
  filters: {
    month?: string;
    scope?: string;
    nature?: string;
    query?: string;
    topic?: string;
  } = {},
) {
  const query = (filters.query || '').trim().toLowerCase();
  return records.filter(
    (item) =>
      (!filters.month || item.date.startsWith(filters.month)) &&
      (!filters.scope || item.scope === filters.scope) &&
      (!filters.nature || item.nature === filters.nature) &&
      (!filters.topic || item.topic === filters.topic) &&
      (!query ||
        `${item.title} ${item.summary} ${item.topic}`
          .toLowerCase()
          .includes(query)),
  );
}
export function overviewStats(records: DemoMeeting[]) {
  const actions = records.flatMap((item) => item.actions);
  const closed = actions.filter((item) => item.closed).length;
  return {
    meetings: records.length,
    minutes: records.filter((item) => item.hasMinutes).length,
    actions: actions.length,
    closed,
    pending: actions.length - closed,
    completion: actions.length
      ? Math.round((closed / actions.length) * 100)
      : 0,
  };
}
export function demoTrend(records: DemoMeeting[]) {
  return MONTHS.map(([month]) => ({
    month,
    total: records.filter((item) => item.date.startsWith(month)).length,
    scopes: SCOPES.filter(
      (scope, index, array) => array.indexOf(scope) === index,
    ).map((scope) => ({
      scope,
      count: records.filter(
        (item) => item.scope === scope && item.date.startsWith(month),
      ).length,
    })),
  }));
}
