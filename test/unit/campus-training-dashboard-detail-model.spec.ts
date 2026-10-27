import {
  buildMetricDetail,
  buildNewHireDetail,
  buildNewHirePlanListDetail,
  buildParticipationDetail,
  buildProgressDetail,
  buildSharingDetail,
  type TrainingDetail,
} from '../../client/src/pages/CampusTrainingDashboard/training-detail-model';
import type { CampusTrainingDashboardResponse } from '../../client/src/pages/CampusTrainingDashboard/model';

function dashboardFixture() {
  const details = {
    assessmentPassScore: 80,
    activeCoursePlans: [
      {
        id: 'plan-june',
        month: '2026-06',
        building: 'A楼',
        course: '消防制度',
        status: '已完成培训考核',
        assignedParticipants: 10,
        actualParticipants: 9,
        completedAt: '2026-06-20',
      },
      {
        id: 'plan-july-a',
        month: '2026-07',
        building: 'A楼',
        course: '应急管理制度',
        status: '已完成培训考核',
        assignedParticipants: 11,
        actualParticipants: 10,
        completedAt: '2026-07-20',
      },
      {
        id: 'plan-july-a-duplicate-building',
        month: '2026-07',
        building: 'B楼',
        course: '应急管理制度',
        status: '已完成培训考核',
        assignedParticipants: 10,
        actualParticipants: 9,
        completedAt: '2026-07-20',
      },
      {
        id: 'plan-july-b',
        month: '2026-07',
        building: 'B楼',
        course: 'UPS操作',
        status: '计划中',
        assignedParticipants: 10,
        actualParticipants: 0,
        completedAt: null,
      },
      {
        id: 'plan-deceptive-completed-label',
        month: '2026-07',
        building: 'C楼',
        course: '不应纳入年度完成',
        status: '已完成资料准备',
        assignedParticipants: 10,
        actualParticipants: 0,
        completedAt: null,
      },
    ],
    participants: [
      {
        id: 'participant-a',
        name: '张三',
        building: 'A楼',
        totalCourses: 4,
        passedCourses: 1,
        failedCourses: 1,
        pendingCourses: 1,
        absentCourses: 1,
        averageScore: 70,
        assessments: [
          {
            id: 'assessment-passed',
            course: '应急管理制度',
            score: 80,
            signedIn: true,
            status: 'passed',
          },
          {
            id: 'assessment-failed',
            course: '风险管理制度',
            score: 60,
            signedIn: true,
            status: 'failed',
          },
          {
            id: 'assessment-pending',
            course: 'UPS操作',
            score: null,
            signedIn: true,
            status: 'pending',
          },
          {
            id: 'assessment-absent',
            course: '消防演练',
            score: null,
            signedIn: false,
            status: 'absent',
          },
        ],
      },
      {
        id: 'participant-b',
        name: '李四',
        building: 'B楼',
        totalCourses: 1,
        passedCourses: 1,
        failedCourses: 0,
        pendingCourses: 0,
        absentCourses: 0,
        averageScore: 90,
        assessments: [
          {
            id: 'assessment-b',
            course: 'UPS操作',
            score: 90,
            signedIn: true,
            status: 'passed',
          },
        ],
      },
    ],
    newHires: [
      {
        id: 'new-hire-a',
        name: '王五',
        building: 'A楼',
        joinedAt: '2026-07-03',
        assessmentDueAt: '2026-09-30',
        requiredCourses: 2,
        completedCourses: 1,
        progress: 50,
        finalScore: null,
      },
    ],
    sharingSessions: [
      {
        id: 'sharing-june',
        month: '2026-06',
        topic: '六月技术交流',
        category: '技术经验分享',
        status: '已结束',
        startedAt: '2026-06-10T09:00:00.000Z',
        endedAt: '2026-06-10T10:00:00.000Z',
        presenterNames: ['赵六'],
        participantCount: 10,
        buildings: ['A楼'],
        durationHours: 1,
        hasMaterial: true,
      },
      {
        id: 'sharing-july',
        month: '2026-07',
        topic: '七月故障复盘',
        category: '故障案例分析',
        status: '待开展',
        startedAt: null,
        endedAt: null,
        presenterNames: ['钱七'],
        participantCount: 12,
        buildings: ['A楼', 'B楼'],
        durationHours: 1.5,
        hasMaterial: false,
      },
      {
        id: 'sharing-terminated',
        month: '2026-07',
        topic: '已终止分享会',
        category: '技术经验分享',
        status: '已终止',
        startedAt: null,
        endedAt: null,
        presenterNames: [],
        participantCount: 0,
        buildings: [],
        durationHours: 0,
        hasMaterial: false,
      },
      {
        id: 'sharing-non-normalized-completed',
        month: '2026-06',
        topic: '不应纳入已开展分享会',
        category: '技术经验分享',
        status: '已完成',
        startedAt: '2026-06-12T09:00:00.000Z',
        endedAt: '2026-06-12T10:00:00.000Z',
        presenterNames: ['吴九'],
        participantCount: 8,
        buildings: ['C楼'],
        durationHours: 1,
        hasMaterial: true,
      },
    ],
    reconciliationNotes: [
      '本年度已培训课程：看板累计统计字段=22，计划表按月份×课程去重=2',
      '本月计划性培训课程：统计卡=12，当前可追溯明细=4',
      '本月参与培训人员：统计卡=2，当前可追溯明细=1',
      '本月新人培训：统计卡=1，当前可追溯明细=0',
      '历史分享会：统计卡=12，当前可追溯明细=1',
      '本月计划进行分享会：统计卡=2，当前可追溯明细=1',
      '本月考核进展：统计表楼栋完成合计=29，计划表楼栋×课程完成标记=0，当前无法逐项追溯',
    ],
  };

  const comparison = { change: 0, direction: 'up' as const, favorable: true };
  return {
    month: '2026-07',
    availableMonths: ['2026-07'],
    summary: {
      annualCompletedCourses: 22,
      monthlyPlannedCourses: 12,
      monthlyParticipants: 2,
      monthlyNewHires: 1,
      historicalSharingSessions: 1,
      monthlyPlannedSharingSessions: 1,
    },
    metricComparisons: {
      annualCompletedCourses: comparison,
      monthlyPlannedCourses: comparison,
      monthlyParticipants: comparison,
      monthlyNewHires: comparison,
      historicalSharingSessions: comparison,
      monthlyPlannedSharingSessions: comparison,
    },
    metricTrends: {
      annualCompletedCourses: [],
      monthlyPlannedCourses: [],
      monthlyParticipants: [],
      monthlyNewHires: [],
      historicalSharingSessions: [],
      monthlyPlannedSharingSessions: [],
    },
    progress: [
      { building: 'A楼', planned: 12, completed: 4, rate: 33.3 },
      { building: 'B楼', planned: 12, completed: 4, rate: 33.3 },
      { building: 'C楼', planned: 12, completed: 5, rate: 41.7 },
      { building: 'D楼', planned: 12, completed: 5, rate: 41.7 },
      { building: 'E楼', planned: 12, completed: 6, rate: 50 },
      { building: 'H楼', planned: 12, completed: 5, rate: 41.7 },
    ],
    participation: [],
    newHirePlans: [
      ...details.newHires,
      {
        id: 'new-hire-prior-month',
        name: '周八',
        building: 'B楼',
        joinedAt: '2026-06-25',
        assessmentDueAt: '2026-09-20',
        requiredCourses: 3,
        completedCourses: 1,
        progress: 33.3,
        finalScore: null,
      },
    ],
    sharing: {
      categories: [],
      trend: [],
      participants: 0,
      totalHours: 0,
      satisfaction: 0,
      materials: 0,
      interests: [],
    },
    courses: [],
    details,
    sourceUpdatedAt: null,
    syncedAt: '2026-07-28T00:00:00.000Z',
    sourceStatus: 'fresh',
    dataStatus: 'ready',
  } as unknown as CampusTrainingDashboardResponse & { details: typeof details };
}

function detailText(detail: TrainingDetail): string {
  return JSON.stringify(detail);
}

describe('campus training dashboard detail model', () => {
  it('builds traceable lists for all six summary metrics', () => {
    const dashboard = dashboardFixture();
    const expectations = [
      ['annualCompletedCourses', '消防制度'],
      ['monthlyPlannedCourses', 'UPS操作'],
      ['monthlyParticipants', '张三'],
      ['monthlyNewHires', '王五'],
      ['historicalSharingSessions', '六月技术交流'],
      ['monthlyPlannedSharingSessions', '七月故障复盘'],
    ] as const;

    for (const [metric, expectedDetail] of expectations) {
      const detail = buildMetricDetail(metric, dashboard);
      expect(detail.table?.rows.length).toBeGreaterThan(0);
      expect(detailText(detail)).toContain(expectedDetail);
    }
    const annualDetail = buildMetricDetail('annualCompletedCourses', dashboard);
    expect(annualDetail.facts).toEqual(
      expect.arrayContaining([
        { label: '明细行', value: 3 },
        { label: '去重完成课程', value: 2 },
      ]),
    );
    expect(annualDetail.sourceNote).toContain(
      '本年度已培训课程：看板累计统计字段=22',
    );
    expect(annualDetail.sourceNote).not.toContain('本月考核进展');
    expect(annualDetail.sourceNote).not.toContain('历史分享会');
    expect(detailText(annualDetail)).not.toContain('UPS操作');
    expect(detailText(annualDetail)).not.toContain('不应纳入年度完成');

    const monthlyPlanDetail = buildMetricDetail(
      'monthlyPlannedCourses',
      dashboard,
    );
    expect(monthlyPlanDetail.facts).toEqual(
      expect.arrayContaining([
        { label: '看板统计', value: 12 },
        { label: '明细行', value: 4 },
        { label: '去重计划课程', value: 3 },
      ]),
    );
    expect(monthlyPlanDetail.facts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '可追溯明细' }),
      ]),
    );
  });

  it('returns course-plan rows and per-person assessment rows for chart and building drilldowns', () => {
    const dashboard = dashboardFixture();
    const progressDetail = buildProgressDetail(dashboard);
    const participationDetail = buildParticipationDetail('A楼', dashboard);

    expect(detailText(progressDetail)).toContain('应急管理制度');
    expect(detailText(progressDetail)).toContain('A楼');
    expect(participationDetail.table?.columns).toEqual([
      '人员',
      '课程',
      '签到',
      '考试分数',
      '考核状态',
    ]);
    expect(participationDetail.table?.rows).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['张三', '通过']),
        expect.arrayContaining(['张三', '未通过']),
        expect.arrayContaining(['张三', '待考核']),
        expect.arrayContaining(['张三', '未签到']),
      ]),
    );
    expect(participationDetail.thresholdNote).toContain('考核课程达标率');
    expect(participationDetail.thresholdNote).toContain('不同口径');
    expect(participationDetail.sourceNote).toContain('本月参与培训人员');
    expect(participationDetail.sourceNote).not.toContain('本年度已培训课程');
    expect(participationDetail.sourceNote).not.toContain('本月考核进展');
  });

  it('separates progress summary totals from traceable per-course completion marks', () => {
    const dashboard = dashboardFixture();
    dashboard.details.activeCoursePlans = [
      {
        id: 'plan-unmarked',
        month: '2026-07',
        building: 'A楼',
        course: '未标记完成状态的课程',
        status: '',
        assignedParticipants: 10,
        actualParticipants: 10,
        completedAt: null,
      },
    ];

    const detail = buildProgressDetail(dashboard);

    expect(detail.facts).toEqual(
      expect.arrayContaining([
        { label: '统计表已完成考核课程', value: 29 },
        { label: '计划表逐课完成标记', value: 0 },
      ]),
    );
    expect(detail.sourceNote).toContain('统计表楼栋完成合计=29');
    expect(detail.sourceNote).toContain('计划表楼栋×课程完成标记=0');
    expect(detail.sourceNote).toContain('本月考核进展');
    expect(detail.sourceNote).not.toContain('本年度已培训课程');
    expect(detail.sourceNote).not.toContain('历史分享会');
    expect(detail.sourceNote?.match(/统计表/g) ?? []).toHaveLength(1);
    expect(detail.sourceNote?.match(/计划表/g) ?? []).toHaveLength(1);
    expect(detail.table?.rows[0]).toContain('未标记');

    dashboard.details.reconciliationNotes =
      dashboard.details.reconciliationNotes.filter(
        (note) => !note.startsWith('本月考核进展'),
      );
    const fallbackDetail = buildProgressDetail(dashboard);
    expect(fallbackDetail.sourceNote).toContain('统计表有汇总数');
    expect(fallbackDetail.sourceNote).toContain('计划表暂不能逐项追溯');
  });

  it('keeps new-hire and sharing dialogs tied to concrete source records', () => {
    const dashboard = dashboardFixture();

    expect(
      detailText(buildNewHireDetail(dashboard.details.newHires[0])),
    ).toContain('王五');
    const sharingDetail = buildSharingDetail(dashboard);
    expect(sharingDetail.description).toContain(
      '截至 2026-07 已开展分享会明细',
    );
    expect(detailText(sharingDetail)).toContain('六月技术交流');
    expect(detailText(sharingDetail)).toContain('赵六');
    expect(detailText(sharingDetail)).not.toContain('七月故障复盘');
    expect(detailText(sharingDetail)).not.toContain('已终止分享会');
    expect(detailText(sharingDetail)).not.toContain('不应纳入已开展分享会');
    expect(sharingDetail.sourceNote).toContain('历史分享会');
    expect(sharingDetail.sourceNote).not.toContain('本年度已培训课程');
    expect(sharingDetail.sourceNote).not.toContain('本月考核进展');
  });

  it('uses the visible new-hire plan rows for the parent-card detail list', () => {
    const dashboard = dashboardFixture();
    const metricDetail = buildMetricDetail('monthlyNewHires', dashboard);
    const parentListDetail = buildNewHirePlanListDetail(
      dashboard.newHirePlans,
      dashboard,
    );

    expect(detailText(metricDetail)).toContain('王五');
    expect(detailText(metricDetail)).not.toContain('周八');
    expect(detailText(parentListDetail)).toContain('王五');
    expect(detailText(parentListDetail)).toContain('周八');
    expect(metricDetail.sourceNote).toContain('本月新人培训');
    expect(metricDetail.sourceNote).not.toContain('本年度已培训课程');
    expect(metricDetail.sourceNote).not.toContain('本月考核进展');
    expect(parentListDetail.sourceNote).not.toContain('本年度已培训课程');
    expect(parentListDetail.sourceNote).not.toContain('本月考核进展');
  });

  it('provides an explicit empty state when a detail source has no rows', () => {
    const dashboard = dashboardFixture();
    dashboard.details.activeCoursePlans = [];
    dashboard.details.participants = [];
    dashboard.details.newHires = [];
    dashboard.details.sharingSessions = [];

    for (const detail of [
      buildMetricDetail('monthlyParticipants', dashboard),
      buildProgressDetail(dashboard),
      buildParticipationDetail('A楼', dashboard),
      buildSharingDetail(dashboard),
    ]) {
      expect(detail.table?.rows).toEqual([]);
      expect(detail.emptyMessage).toBeTruthy();
    }
  });
});
