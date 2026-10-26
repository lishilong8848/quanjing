import type {
  ActiveTrainingCoursePlanDetail,
  CampusTrainingDashboardResponse,
  NewHirePlan,
  TrainingAssessmentDetail,
  TrainingDashboardDetails,
  TrainingMetricKey,
  TrainingParticipantDetail,
  TrainingSharingSessionDetail,
} from './model';

export type TrainingDetailValue = string | number;

export interface TrainingDetail {
  title: string;
  description: string;
  sourceNote?: string;
  thresholdNote?: string;
  emptyMessage?: string;
  facts?: Array<{ label: string; value: TrainingDetailValue }>;
  table?: {
    columns: string[];
    rows: TrainingDetailValue[][];
  };
}

const METRIC_LABELS: Record<TrainingMetricKey, string> = {
  annualCompletedCourses: '本年度已培训课程',
  monthlyPlannedCourses: '本月计划性培训课程',
  monthlyParticipants: '本月参与培训人员',
  monthlyNewHires: '本月新人培训',
  historicalSharingSessions: '历史分享会',
  monthlyPlannedSharingSessions: '本月计划进行分享会',
};

const METRIC_RECONCILIATION_PREFIXES: Record<TrainingMetricKey, string> = {
  annualCompletedCourses: '本年度已培训课程',
  monthlyPlannedCourses: '本月计划性培训课程',
  monthlyParticipants: '本月参与培训人员',
  monthlyNewHires: '本月新人培训',
  historicalSharingSessions: '历史分享会',
  monthlyPlannedSharingSessions: '本月计划进行分享会',
};

const STATUS_LABELS: Record<TrainingAssessmentDetail['status'], string> = {
  passed: '通过',
  failed: '未通过',
  pending: '待考核',
  absent: '未签到',
};

const DEFAULT_SOURCE_NOTE =
  '明细来自当前页面已加载的飞书多维表快照，打开弹窗不会重复请求数据。';
const DEFAULT_EMPTY_MESSAGE = '暂无符合当前统计口径的可追溯明细';

function dashboardDetails(
  dashboard: CampusTrainingDashboardResponse,
): TrainingDashboardDetails {
  return dashboard.details;
}

function formatNullable(value: string | number | null): TrainingDetailValue {
  return value === null || value === '' ? '—' : value;
}

function formatPeople(value: number): string {
  return `${value} 人`;
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function isCompletedCourse(item: ActiveTrainingCoursePlanDetail): boolean {
  return item.status === '已完成培训考核' || item.completedAt !== null;
}

function isTerminated(status: string): boolean {
  return /终止|取消|作废/.test(status);
}

function isCompletedSharing(item: TrainingSharingSessionDetail): boolean {
  return item.status === '已结束';
}

function reconciliationSourceNote(
  details: TrainingDashboardDetails,
  prefixes: readonly string[],
): string {
  const relevantNotes = details.reconciliationNotes.filter((note) =>
    prefixes.some((prefix) => note.startsWith(prefix)),
  );
  return relevantNotes.length > 0
    ? `${DEFAULT_SOURCE_NOTE} ${relevantNotes.join('；')}`
    : DEFAULT_SOURCE_NOTE;
}

function coursePlanRows(
  items: readonly ActiveTrainingCoursePlanDetail[],
): TrainingDetailValue[][] {
  return items.map((item) => [
    item.month,
    item.building || '未分配',
    item.course || '未命名课程',
    item.status || '未标记',
    item.assignedParticipants,
    item.actualParticipants,
    formatNullable(item.completedAt),
  ]);
}

function participantRows(
  items: readonly TrainingParticipantDetail[],
): TrainingDetailValue[][] {
  return items.map((item) => [
    item.name || '未命名人员',
    item.building || '未分配',
    item.totalCourses,
    item.passedCourses,
    item.failedCourses,
    item.pendingCourses,
    item.absentCourses,
    formatNullable(item.averageScore),
  ]);
}

function newHireRows(items: readonly NewHirePlan[]): TrainingDetailValue[][] {
  return items.map((item) => [
    item.name || '未命名人员',
    item.building || '未分配',
    formatNullable(item.joinedAt),
    formatNullable(item.assessmentDueAt),
    item.requiredCourses,
    item.completedCourses,
    `${item.progress}%`,
    formatNullable(item.finalScore),
  ]);
}

function sharingRows(
  items: readonly TrainingSharingSessionDetail[],
): TrainingDetailValue[][] {
  return items.map((item) => [
    item.month,
    item.topic || '未命名分享会',
    item.category || '未分类',
    item.status || '未标记',
    item.presenterNames.length > 0 ? item.presenterNames.join('、') : '—',
    item.participantCount,
    item.buildings.length > 0 ? item.buildings.join('、') : '—',
    formatNullable(item.startedAt),
    formatNullable(item.endedAt),
    `${item.durationHours} h`,
    item.hasMaterial ? '已沉淀' : '暂无',
  ]);
}

function metricFacts(
  dashboard: CampusTrainingDashboardResponse,
  key: TrainingMetricKey,
  rowCount: number,
): TrainingDetail['facts'] {
  return [
    { label: '看板统计', value: dashboard.summary[key] },
    { label: '可追溯明细', value: rowCount },
  ];
}

export function buildMetricDetail(
  key: TrainingMetricKey,
  dashboard: CampusTrainingDashboardResponse,
): TrainingDetail {
  const details = dashboardDetails(dashboard);
  const common = {
    title: METRIC_LABELS[key],
    description: `${dashboard.month} 指标对应的源数据明细`,
    sourceNote: reconciliationSourceNote(details, [
      METRIC_RECONCILIATION_PREFIXES[key],
    ]),
    emptyMessage: DEFAULT_EMPTY_MESSAGE,
  };

  if (key === 'annualCompletedCourses') {
    const year = dashboard.month.slice(0, 4);
    const items = details.activeCoursePlans.filter(
      (item) => item.month.startsWith(year) && isCompletedCourse(item),
    );
    const rows = coursePlanRows(items);
    const uniqueCompletedCourses = new Set(
      items.map((item) => `${item.month}\u0000${item.course}`),
    ).size;
    return {
      ...common,
      description: `${year} 年已完成培训课程清单`,
      facts: [
        { label: '看板统计', value: dashboard.summary[key] },
        { label: '明细行', value: rows.length },
        { label: '去重完成课程', value: uniqueCompletedCourses },
      ],
      table: {
        columns: [
          '月份',
          '楼栋',
          '课程',
          '状态',
          '应参与人数',
          '实际参与人数',
          '完成时间',
        ],
        rows,
      },
    };
  }

  if (key === 'monthlyPlannedCourses') {
    const items = details.activeCoursePlans.filter(
      (item) => item.month === dashboard.month && !isTerminated(item.status),
    );
    const rows = coursePlanRows(items);
    const uniquePlannedCourses = new Set(items.map((item) => item.course)).size;
    return {
      ...common,
      facts: [
        { label: '看板统计', value: dashboard.summary[key] },
        { label: '明细行', value: rows.length },
        { label: '去重计划课程', value: uniquePlannedCourses },
      ],
      table: {
        columns: [
          '月份',
          '楼栋',
          '课程',
          '状态',
          '应参与人数',
          '实际参与人数',
          '完成时间',
        ],
        rows,
      },
    };
  }

  if (key === 'monthlyParticipants') {
    const rows = participantRows(details.participants);
    return {
      ...common,
      thresholdNote: `考核通过阈值：${details.assessmentPassScore} 分；空成绩计为待考核，不计入未通过。`,
      facts: metricFacts(dashboard, key, rows.length),
      table: {
        columns: [
          '人员',
          '楼栋',
          '课程总数',
          '通过',
          '未通过',
          '待考核',
          '未签到',
          '平均分',
        ],
        rows,
      },
    };
  }

  if (key === 'monthlyNewHires') {
    const rows = newHireRows(details.newHires);
    return {
      ...common,
      facts: metricFacts(dashboard, key, rows.length),
      table: {
        columns: [
          '人员',
          '楼栋',
          '入职日期',
          '考核截止日期',
          '需培训课程',
          '已完成课程',
          '培训进度',
          '最终成绩',
        ],
        rows,
      },
    };
  }

  const sharingItems =
    key === 'historicalSharingSessions'
      ? details.sharingSessions.filter(isCompletedSharing)
      : details.sharingSessions.filter(
          (item) =>
            item.month === dashboard.month && !isTerminated(item.status),
        );
  const rows = sharingRows(sharingItems);
  return {
    ...common,
    facts: metricFacts(dashboard, key, rows.length),
    table: {
      columns: [
        '月份',
        '主题',
        '类型',
        '状态',
        '分享人',
        '参与人数',
        '楼栋',
        '开始时间',
        '结束时间',
        '时长',
        '资料',
      ],
      rows,
    },
  };
}

export function buildProgressDetail(
  dashboard: CampusTrainingDashboardResponse,
): TrainingDetail {
  const details = dashboardDetails(dashboard);
  const items = details.activeCoursePlans.filter(
    (item) => item.month === dashboard.month && !isTerminated(item.status),
  );
  const rows = coursePlanRows(items);
  const summaryCompletedCourses = dashboard.progress.reduce(
    (sum, item) => sum + item.completed,
    0,
  );
  const traceableCompletedCourses = items.filter(isCompletedCourse).length;
  const hasBackendProgressNote = details.reconciliationNotes.some((note) =>
    note.startsWith('本月考核进展'),
  );
  const progressSourceNote = reconciliationSourceNote(details, [
    '本月考核进展',
  ]);
  const sourceNote =
    !hasBackendProgressNote &&
    summaryCompletedCourses !== traceableCompletedCourses
      ? `${progressSourceNote} 统计表有汇总数：已完成考核课程 ${summaryCompletedCourses} 门；计划表暂不能逐项追溯全部完成状态，当前逐课完成标记 ${traceableCompletedCourses} 门。`
      : progressSourceNote;
  return {
    title: '本月在岗考核课程进展',
    description: `${dashboard.month} 各楼栋课程计划与完成明细`,
    sourceNote,
    emptyMessage: DEFAULT_EMPTY_MESSAGE,
    facts: [
      { label: '课程计划', value: rows.length },
      {
        label: '统计表已完成考核课程',
        value: summaryCompletedCourses,
      },
      {
        label: '计划表逐课完成标记',
        value: traceableCompletedCourses,
      },
    ],
    table: {
      columns: [
        '月份',
        '楼栋',
        '课程',
        '状态',
        '应参与人数',
        '实际参与人数',
        '完成时间',
      ],
      rows,
    },
  };
}

export function buildParticipationDetail(
  building: string,
  dashboard: CampusTrainingDashboardResponse,
): TrainingDetail {
  const details = dashboardDetails(dashboard);
  const participants = details.participants.filter(
    (item) => item.building === building,
  );
  const rows = participants.flatMap((participant) =>
    participant.assessments.map((assessment) => [
      participant.name || '未命名人员',
      assessment.course || '未命名课程',
      assessment.signedIn === null
        ? '未记录'
        : assessment.signedIn
          ? '已签到'
          : '未签到',
      formatNullable(assessment.score),
      STATUS_LABELS[assessment.status],
    ]),
  );
  const failedCount = participants.reduce(
    (sum, item) => sum + item.failedCourses,
    0,
  );
  const pendingCount = participants.reduce(
    (sum, item) => sum + item.pendingCourses,
    0,
  );

  return {
    title: `${building}培训情况`,
    description: `${dashboard.month} 在岗员工逐人逐课程培训明细`,
    sourceNote: reconciliationSourceNote(details, ['本月参与培训人员']),
    thresholdNote: `卡片中的“考核课程达标率”表示已完成考核课程÷需考核课程；本清单按 ${details.assessmentPassScore} 分阈值判断人员“通过/未通过”，空成绩计为待考核。两者为不同口径。`,
    emptyMessage: `暂无${building}人员培训明细`,
    facts: [
      { label: '参与人员', value: formatPeople(participants.length) },
      { label: '未通过课程', value: failedCount },
      { label: '待考核课程', value: pendingCount },
      {
        label: '未签到课程',
        value: participants.reduce((sum, item) => sum + item.absentCourses, 0),
      },
    ],
    table: {
      columns: ['人员', '课程', '签到', '考试分数', '考核状态'],
      rows,
    },
  };
}

export function buildNewHireDetail(item: NewHirePlan): TrainingDetail {
  return {
    title: `${item.name}新人培训计划`,
    description: `${item.building || '未分配楼栋'}新人培训执行明细`,
    sourceNote: DEFAULT_SOURCE_NOTE,
    emptyMessage: DEFAULT_EMPTY_MESSAGE,
    facts: [
      { label: '需培训课程', value: item.requiredCourses },
      { label: '已完成课程', value: item.completedCourses },
      { label: '培训进度', value: `${item.progress}%` },
      {
        label: '最终考核成绩',
        value: formatNullable(item.finalScore),
      },
    ],
    table: {
      columns: [
        '人员',
        '楼栋',
        '入职日期',
        '考核截止日期',
        '需培训课程',
        '已完成课程',
        '培训进度',
        '最终成绩',
      ],
      rows: newHireRows([item]),
    },
  };
}

export function buildNewHirePlanListDetail(
  items: readonly NewHirePlan[],
  dashboard: CampusTrainingDashboardResponse,
): TrainingDetail {
  const rows = newHireRows(items);
  return {
    title: '新人培训计划',
    description: `${dashboard.month} 当前培训窗口内新人计划清单`,
    sourceNote: DEFAULT_SOURCE_NOTE,
    emptyMessage: DEFAULT_EMPTY_MESSAGE,
    facts: [
      { label: '计划人员', value: rows.length },
      {
        label: '尚未完成',
        value: items.filter(
          (item) => item.completedCourses < item.requiredCourses,
        ).length,
      },
    ],
    table: {
      columns: [
        '人员',
        '楼栋',
        '入职日期',
        '考核截止日期',
        '需培训课程',
        '已完成课程',
        '培训进度',
        '最终成绩',
      ],
      rows,
    },
  };
}

export function buildSharingDetail(
  dashboard: CampusTrainingDashboardResponse,
): TrainingDetail {
  const details = dashboardDetails(dashboard);
  const sessions = details.sharingSessions.filter(
    (item) => item.month <= dashboard.month && isCompletedSharing(item),
  );
  return {
    title: '分享会开展情况',
    description: `截至 ${dashboard.month} 已开展分享会明细`,
    sourceNote: reconciliationSourceNote(details, ['历史分享会']),
    emptyMessage: DEFAULT_EMPTY_MESSAGE,
    facts: [
      { label: '可追溯场次', value: sessions.length },
      {
        label: '参与人数',
        value: formatPeople(dashboard.sharing.participants),
      },
      { label: '累计时长', value: `${dashboard.sharing.totalHours} h` },
      { label: '资料沉淀', value: `${dashboard.sharing.materials} 份` },
    ],
    table: {
      columns: [
        '月份',
        '主题',
        '类型',
        '状态',
        '分享人',
        '参与人数',
        '楼栋',
        '开始时间',
        '结束时间',
        '时长',
        '资料',
      ],
      rows: sharingRows(sessions),
    },
  };
}

export function buildOverviewDetail(
  dashboard: CampusTrainingDashboardResponse,
): TrainingDetail {
  return {
    title: '员工培训概览',
    description: `${dashboard.month} 培训看板数据概览`,
    sourceNote: DEFAULT_SOURCE_NOTE,
    facts: (Object.keys(METRIC_LABELS) as TrainingMetricKey[]).map((key) => ({
      label: METRIC_LABELS[key],
      value: dashboard.summary[key],
    })),
  };
}

export interface TrainingDetailPage {
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  rows: TrainingDetailValue[][];
}

export function paginateTrainingDetailRows(
  detail: TrainingDetail,
  requestedPage: number,
  pageSize = 50,
): TrainingDetailPage {
  const rows = detail.table?.rows ?? [];
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(rows.length / safePageSize));
  const page = Math.min(totalPages, Math.max(1, Math.floor(requestedPage)));
  const start = (page - 1) * safePageSize;
  return {
    page,
    pageSize: safePageSize,
    totalRows: rows.length,
    totalPages,
    rows: rows.slice(start, start + safePageSize),
  };
}
