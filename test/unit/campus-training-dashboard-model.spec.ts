import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  chartMax,
  formatTrainingMonth,
  isTrainingMonth,
  safeRate,
  type CampusTrainingDashboardResponse,
  type NewHirePlan,
  type TrainingMetricKey,
} from '../../client/src/pages/CampusTrainingDashboard/model';
import * as trainingDashboardModel from '../../client/src/pages/CampusTrainingDashboard/model';

const modelSource = readFileSync(
  join(process.cwd(), 'client/src/pages/CampusTrainingDashboard/model.ts'),
  'utf8',
);
const sharedInterfaceSource = readFileSync(
  join(process.cwd(), 'shared/campus-training-dashboard.interface.ts'),
  'utf8',
);

type TrainingAssessmentStatus = 'passed' | 'failed' | 'pending' | 'absent';

interface TestTrainingAssessmentDetail {
  id: string;
  course: string;
  score: number | null;
  signedIn: boolean | null;
  status: TrainingAssessmentStatus;
}

interface TestTrainingParticipantDetail {
  id: string;
  name: string;
  building: string;
  totalCourses: number;
  passedCourses: number;
  failedCourses: number;
  pendingCourses: number;
  absentCourses: number;
  averageScore: number | null;
  assessments: TestTrainingAssessmentDetail[];
}

interface TestActiveTrainingCoursePlanDetail {
  id: string;
  month: string;
  building: string;
  course: string;
  status: string;
  assignedParticipants: number;
  actualParticipants: number;
  completedAt: string | null;
}

interface TestTrainingSharingSessionDetail {
  id: string;
  month: string;
  topic: string;
  category: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  presenterNames: string[];
  participantCount: number;
  buildings: string[];
  durationHours: number;
  hasMaterial: boolean;
}

interface TestTrainingDashboardDetails {
  assessmentPassScore: number;
  activeCoursePlans: TestActiveTrainingCoursePlanDetail[];
  participants: TestTrainingParticipantDetail[];
  newHires: NewHirePlan[];
  sharingSessions: TestTrainingSharingSessionDetail[];
  reconciliationNotes: string[];
}

type DetailedCampusTrainingDashboardResponse =
  CampusTrainingDashboardResponse & {
    details: TestTrainingDashboardDetails;
  };

const TRAINING_METRIC_KEYS: readonly TrainingMetricKey[] = [
  'annualCompletedCourses',
  'monthlyPlannedCourses',
  'monthlyParticipants',
  'monthlyNewHires',
  'historicalSharingSessions',
  'monthlyPlannedSharingSessions',
];

function minimalDashboardResponse(): DetailedCampusTrainingDashboardResponse {
  const comparison = {
    change: 0,
    direction: 'up' as const,
    favorable: true,
  };
  return {
    month: '2026-07',
    availableMonths: ['2026-07'],
    summary: {
      annualCompletedCourses: 0,
      monthlyPlannedCourses: 0,
      monthlyParticipants: 0,
      monthlyNewHires: 0,
      historicalSharingSessions: 0,
      monthlyPlannedSharingSessions: 0,
    },
    metricComparisons: {
      annualCompletedCourses: { ...comparison },
      monthlyPlannedCourses: { ...comparison },
      monthlyParticipants: { ...comparison },
      monthlyNewHires: { ...comparison },
      historicalSharingSessions: { ...comparison },
      monthlyPlannedSharingSessions: { ...comparison },
    },
    metricTrends: {
      annualCompletedCourses: [],
      monthlyPlannedCourses: [],
      monthlyParticipants: [],
      monthlyNewHires: [],
      historicalSharingSessions: [],
      monthlyPlannedSharingSessions: [],
    },
    progress: [],
    participation: [],
    newHirePlans: [],
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
    details: {
      assessmentPassScore: 80,
      activeCoursePlans: [],
      participants: [],
      newHires: [],
      sharingSessions: [],
      reconciliationNotes: [],
    },
    sourceUpdatedAt: null,
    syncedAt: '2026-07-19T03:00:00.000Z',
    sourceStatus: 'fresh',
    dataStatus: 'empty',
  };
}

function responseValidator(): (value: unknown) => boolean {
  const validator = (
    trainingDashboardModel as unknown as {
      isCampusTrainingDashboardResponse?: unknown;
    }
  ).isCampusTrainingDashboardResponse;
  expect(typeof validator).toBe('function');
  return validator as (value: unknown) => boolean;
}

function currentMonthFormatter(): (now?: Date) => string {
  const formatter = (
    trainingDashboardModel as unknown as {
      currentTrainingMonth?: unknown;
    }
  ).currentTrainingMonth;
  expect(typeof formatter).toBe('function');
  return formatter as (now?: Date) => string;
}

describe('campus training dashboard model', () => {
  it('validates and formats strict training months', () => {
    expect(isTrainingMonth('2026-07')).toBe(true);
    expect(isTrainingMonth('2026-01')).toBe(true);
    expect(isTrainingMonth('2100-01')).toBe(true);
    expect(isTrainingMonth('2026-7')).toBe(false);
    expect(isTrainingMonth('2026-13')).toBe(false);
    expect(isTrainingMonth('x')).toBe(false);
    expect(formatTrainingMonth('2026-07')).toBe('2026-07');
    expect(formatTrainingMonth('2026-7')).toBe('未知月份');
  });

  it('keeps rate and chart helpers finite for zero or malformed inputs', () => {
    expect(safeRate(4, 12)).toBe(33);
    expect(safeRate(0, 0)).toBe(0);
    expect(safeRate(Number.NaN, 12)).toBe(0);
    expect(safeRate(4, Number.POSITIVE_INFINITY)).toBe(0);
    expect(chartMax([])).toBe(1);
    expect(chartMax([Number.NaN, Number.POSITIVE_INFINITY])).toBe(1);
    expect(chartMax([0, 4, 12])).toBe(12);
  });

  it('formats the current Shanghai calendar month for the initial dashboard request', () => {
    const formatCurrentMonth = currentMonthFormatter();
    class MisleadingLocalDate extends Date {
      override getFullYear(): number {
        return 1999;
      }

      override getMonth(): number {
        return 0;
      }
    }

    expect(formatCurrentMonth(new Date(2026, 6, 19, 12, 0, 0))).toBe('2026-07');
    expect(formatCurrentMonth(new Date(2027, 0, 1, 0, 0, 0))).toBe('2027-01');
    expect(
      formatCurrentMonth(new MisleadingLocalDate('2026-07-31T16:30:00.000Z')),
    ).toBe('2026-08');
  });

  it('exports a response validator that accepts a complete minimal response', () => {
    const response = minimalDashboardResponse();
    response.participation = [
      {
        building: 'A楼',
        people: 10,
        target: 11,
        trainingCompletionRate: 33.3,
        assessmentPassRate: null,
      },
    ];

    expect(responseValidator()(response)).toBe(true);
  });

  it('declares the complete traceable dashboard details contract', () => {
    expect(sharedInterfaceSource).toContain(
      'export interface TrainingAssessmentDetail',
    );
    expect(sharedInterfaceSource).toContain(
      'export interface TrainingParticipantDetail',
    );
    expect(sharedInterfaceSource).toContain(
      'export interface ActiveTrainingCoursePlanDetail',
    );
    expect(sharedInterfaceSource).toContain(
      'export interface TrainingSharingSessionDetail',
    );
    expect(sharedInterfaceSource).toContain(
      'export interface TrainingDashboardDetails',
    );
    for (const requiredField of [
      'assessmentPassScore',
      'activeCoursePlans',
      'participants',
      'newHires',
      'sharingSessions',
      'reconciliationNotes',
    ]) {
      expect(sharedInterfaceSource).toContain(requiredField);
    }
    expect(sharedInterfaceSource).toContain(
      'details: TrainingDashboardDetails',
    );
  });

  it('requires every details collection and accepts a complete representative payload', () => {
    const validate = responseValidator();
    const response = minimalDashboardResponse();
    response.details = {
      assessmentPassScore: 80,
      activeCoursePlans: [
        {
          id: 'plan-a',
          month: '2026-07',
          building: 'A楼',
          course: '应急管理制度',
          status: '已完成培训考核',
          assignedParticipants: 11,
          actualParticipants: 10,
          completedAt: '2026-07-20',
        },
      ],
      participants: [
        {
          id: 'person-a',
          name: '示例人员008',
          building: 'A楼',
          totalCourses: 2,
          passedCourses: 1,
          failedCourses: 0,
          pendingCourses: 1,
          absentCourses: 0,
          averageScore: 86,
          assessments: [
            {
              id: 'assessment-a',
              course: '应急管理制度',
              score: 86,
              signedIn: true,
              status: 'passed',
            },
            {
              id: 'assessment-b',
              course: 'UPS操作',
              score: null,
              signedIn: true,
              status: 'pending',
            },
          ],
        },
      ],
      newHires: [
        {
          id: 'new-hire-a',
          name: '示例人员017',
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
          id: 'sharing-a',
          month: '2026-07',
          topic: '故障复盘',
          category: '故障案例分析',
          status: '已结束',
          startedAt: '2026-07-10T09:00:00.000Z',
          endedAt: '2026-07-10T10:30:00.000Z',
          presenterNames: ['赵六'],
          participantCount: 12,
          buildings: ['A楼', 'B楼'],
          durationHours: 1.5,
          hasMaterial: true,
        },
      ],
      reconciliationNotes: ['汇总口径与可追溯明细存在差异'],
    };

    expect(validate(response)).toBe(true);

    for (const key of [
      'assessmentPassScore',
      'activeCoursePlans',
      'participants',
      'newHires',
      'sharingSessions',
      'reconciliationNotes',
    ] as const) {
      const details: Partial<TestTrainingDashboardDetails> = {
        ...response.details,
      };
      delete details[key];
      expect(validate({ ...response, details })).toBe(false);
    }
  });

  it('rejects malformed numbers, assessment states, and reconciliation notes in details', () => {
    const validate = responseValidator();
    const response = minimalDashboardResponse();
    const participant: TestTrainingParticipantDetail = {
      id: 'person-a',
      name: '示例人员008',
      building: 'A楼',
      totalCourses: 1,
      passedCourses: 0,
      failedCourses: 0,
      pendingCourses: 1,
      absentCourses: 0,
      averageScore: null,
      assessments: [
        {
          id: 'assessment-a',
          course: 'UPS操作',
          score: null,
          signedIn: true,
          status: 'pending',
        },
      ],
    };
    const sharingSession: TestTrainingSharingSessionDetail = {
      id: 'sharing-a',
      month: '2026-07',
      topic: '故障复盘',
      category: '故障案例分析',
      status: '已结束',
      startedAt: null,
      endedAt: null,
      presenterNames: ['赵六'],
      participantCount: 12,
      buildings: ['A楼'],
      durationHours: 1.5,
      hasMaterial: true,
    };

    const malformedResponses = [
      {
        ...response,
        details: {
          ...response.details,
          assessmentPassScore: Number.NaN,
        },
      },
      {
        ...response,
        details: {
          ...response.details,
          activeCoursePlans: [
            {
              id: 'plan-a',
              month: '2026-07',
              building: 'A楼',
              course: '应急管理制度',
              status: '已完成培训考核',
              assignedParticipants: Number.NaN,
              actualParticipants: 10,
              completedAt: null,
            },
          ],
        },
      },
      {
        ...response,
        details: {
          ...response.details,
          participants: [
            {
              ...participant,
              assessments: [
                {
                  ...participant.assessments[0],
                  status: 'unknown',
                },
              ],
            },
          ],
        },
      },
      {
        ...response,
        details: {
          ...response.details,
          participants: [{ ...participant, averageScore: Number.NaN }],
        },
      },
      {
        ...response,
        details: {
          ...response.details,
          sharingSessions: [{ ...sharingSession, durationHours: Number.NaN }],
        },
      },
      {
        ...response,
        details: {
          ...response.details,
          reconciliationNotes: [42],
        },
      },
    ];

    for (const malformedResponse of malformedResponses) {
      expect(validate(malformedResponse)).toBe(false);
    }
  });

  it('rejects the legacy participation rate contract and malformed assessment rates', () => {
    const validate = responseValidator();
    const response = minimalDashboardResponse();
    const validParticipation = {
      building: 'A楼',
      people: 10,
      target: 11,
      trainingCompletionRate: 33.3,
      assessmentPassRate: 80,
    };

    expect(validate({ ...response, participation: [validParticipation] })).toBe(
      true,
    );
    expect(
      validate({
        ...response,
        participation: [
          {
            building: 'A楼',
            people: 10,
            target: 11,
            rate: 90.9,
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate({
        ...response,
        participation: [
          { ...validParticipation, assessmentPassRate: Number.NaN },
        ],
      }),
    ).toBe(false);
  });

  it('rejects responses missing required month and metric trend fields', () => {
    const validate = responseValidator();
    const response = minimalDashboardResponse();
    const { availableMonths: _availableMonths, ...withoutAvailableMonths } =
      response;

    expect(validate(withoutAvailableMonths)).toBe(false);

    for (const key of TRAINING_METRIC_KEYS) {
      const metricTrends: Partial<
        CampusTrainingDashboardResponse['metricTrends']
      > = { ...response.metricTrends };
      delete metricTrends[key];
      expect(validate({ ...response, metricTrends })).toBe(false);
    }
  });

  it('rejects responses missing sharing or any required sharing array', () => {
    const validate = responseValidator();
    const response = minimalDashboardResponse();
    const { sharing: _sharing, ...withoutSharing } = response;

    expect(validate(withoutSharing)).toBe(false);

    for (const key of ['categories', 'trend', 'interests'] as const) {
      const sharing: Partial<CampusTrainingDashboardResponse['sharing']> = {
        ...response.sharing,
      };
      delete sharing[key];
      expect(validate({ ...response, sharing })).toBe(false);
    }
  });

  it('rejects NaN values anywhere in dashboard numeric data', () => {
    const validate = responseValidator();
    const response = minimalDashboardResponse();
    const invalidResponses = [
      {
        ...response,
        summary: {
          ...response.summary,
          annualCompletedCourses: Number.NaN,
        },
      },
      {
        ...response,
        metricTrends: {
          ...response.metricTrends,
          monthlyNewHires: [Number.NaN],
        },
      },
      {
        ...response,
        sharing: {
          ...response.sharing,
          participants: Number.NaN,
        },
      },
    ];

    for (const invalidResponse of invalidResponses) {
      expect(validate(invalidResponse)).toBe(false);
    }
  });

  it('re-exports shared response types without any static business dataset', () => {
    expect(modelSource).toContain(
      '@shared/campus-training-dashboard.interface',
    );
    for (const staticIdentifier of [
      'SUMMARY_BY_MONTH',
      'TRAINING_METRIC_COMPARISONS',
      'BUILDING_TRAINING_PROGRESS',
      'TRAINING_PARTICIPATION',
      'NEW_HIRE_PLANS',
      'SHARING_CATEGORIES',
      'SHARING_TREND',
      'SHARING_OVERVIEW',
      'TRAINING_COURSES',
      'MINI_TRENDS',
    ]) {
      expect(modelSource).not.toContain(staticIdentifier);
    }
    expect(modelSource).not.toContain('getTrainingDashboardView');
    expect(modelSource).not.toContain('TRAINING_MONTHS');
    expect(modelSource).not.toContain('DEFAULT_TRAINING_MONTH');
  });
});
