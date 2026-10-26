import type {
  AliMonthlyQualityDataset,
  AliMonthlyQualityIssue,
  AliMonthlyQualityRating,
} from '../../shared/risk-inspection.interface';
import {
  buildAliMonthlyQualityView,
  selectMonthlyQualityIssues,
} from '../../client/src/pages/RiskInspectionDashboard/monthly-quality-model';

const BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
const GRADES: Record<string, string[]> = {
  '3月': ['B-', 'B+', 'B+', 'B+', 'A-', 'B+', 'B-'],
  '4月': ['A+', 'A-', 'A-', 'B-', 'B+', 'A+', 'A+'],
  '5月': ['A+', 'A-', 'B-', 'B-', 'B-', 'A-', 'A+'],
  '6月': ['B-', 'A-', 'A+', 'B-', 'B-', 'A-', 'B-'],
  '7月': ['B-', 'A+', 'B-', 'B+', 'B-', 'A+', 'A+'],
};
const CUMULATIVE_A_PLUS = [2, 1, 1, 0, 0, 2, 3];

function issue(
  id: string,
  month: string,
  building: string,
  item: string,
): AliMonthlyQualityIssue {
  return {
    id,
    month,
    building,
    item,
    issue: `${building}${item}问题`,
    supplemental: '',
    attachments: [],
    images: [],
  };
}

function rating(
  month: string,
  building: string,
  grade: string,
  cumulativeAPlus: number,
): AliMonthlyQualityRating {
  return {
    id: `rating-${month}-${building}`,
    year: '2026年',
    month,
    building,
    grade,
    cumulativeAPlus,
    recent: month === '7月',
  };
}

function dataset(): AliMonthlyQualityDataset {
  const ratings = Object.entries(GRADES).flatMap(([month, grades]) =>
    BUILDINGS.map((building, index) =>
      rating(month, building, grades[index], CUMULATIVE_A_PLUS[index]),
    ),
  );

  return {
    issues: [
      issue('jul-a-duty', '7月', 'A楼', '值班纪律'),
      issue('jul-b-form', '7月', 'B楼', '表单记录'),
      issue('jul-c-event', '7月', 'C楼', '事件处理'),
      issue('jul-d-form', '7月', 'D楼', '表单记录'),
      issue('jul-d-event', '7月', 'D楼', '事件处理'),
      issue('jul-e-duty', '7月', 'E楼', '值班纪律'),
      issue('jul-e-form', '7月', 'E楼', '表单记录'),
      issue('jul-h-form', '7月', 'H楼', '表单记录'),
      ...Array.from({ length: 8 }, (_, index) =>
        issue(
          `jun-${index + 1}`,
          '6月',
          BUILDINGS[index % BUILDINGS.length],
          index % 2 === 0 ? '表单记录' : '事件处理',
        ),
      ),
      issue('mar-a-duty', '3月', 'A楼', '值班纪律'),
    ],
    ratings,
    options: {
      years: ['2026年'],
      months: ['7月', '6月', '5月', '4月', '3月'],
      buildings: BUILDINGS,
      items: ['值班纪律', '表单记录', '事件处理'],
    },
    sources: {
      issues: { status: 'fresh', sourceUpdatedAt: null, warning: '' },
      ratings: { status: 'fresh', sourceUpdatedAt: null, warning: '' },
    },
    sourceUpdatedAt: null,
    syncedAt: '2026-08-26T08:00:00.000Z',
    sourceStatus: 'fresh',
    warnings: [],
  };
}

describe('Ali monthly quality rating view model', () => {
  test('uses real ratings for benchmarks, attention and month movement', () => {
    const view = buildAliMonthlyQualityView(dataset(), {
      year: '2026年',
      month: '7月',
      item: 'all',
    });

    expect(view.selectedYear).toBe('2026年');
    expect(view.summary).toMatchObject({
      monthlyIssues: 8,
      ratedBuildings: 7,
      benchmarkBuildings: ['B楼', 'H楼', '110站'],
      attentionBuildings: ['A楼', 'C楼', 'E楼'],
      movement: { up: 4, same: 2, down: 1 },
    });
    expect(view.buildings.find(({ building }) => building === 'A楼')).toEqual(
      expect.objectContaining({
        grade: 'B-',
        previousGrade: 'B-',
        movement: 'same',
        attention: true,
        benchmark: false,
      }),
    );
  });

  test('keeps the 110 station A+ benchmark when its issue count is zero', () => {
    const view = buildAliMonthlyQualityView(dataset(), {
      year: '2026年',
      month: '7月',
      item: 'all',
    });

    expect(view.buildings.find(({ building }) => building === '110站')).toEqual(
      expect.objectContaining({
        grade: 'A+',
        benchmark: true,
        issueCount: 0,
        covered: false,
        cumulativeAPlus: 3,
      }),
    );
  });

  test('uses the same selected month records for evidence drill-downs', () => {
    const view = buildAliMonthlyQualityView(dataset(), {
      year: '2026年',
      month: '7月',
      item: 'all',
    });

    expect(
      selectMonthlyQualityIssues(view, {
        kind: 'building',
        building: 'D楼',
      }).map(({ id }) => id),
    ).toEqual(['jul-d-form', 'jul-d-event']);
    expect(
      selectMonthlyQualityIssues(view, {
        kind: 'matrix',
        building: 'D楼',
        item: '表单记录',
      }).map(({ id }) => id),
    ).toEqual(['jul-d-form']);
  });

  test('falls back to the latest complete rated month and builds the real rating matrix', () => {
    const view = buildAliMonthlyQualityView(dataset(), {
      year: '2026年',
      month: '12月',
      item: 'all',
      building: 'C楼',
    });

    expect(view.selectedMonth).toBe('7月');
    expect(view.selectedBuilding).toBe('C楼');
    expect(view.ratingMatrix.map(({ month }) => month)).toEqual([
      '3月',
      '4月',
      '5月',
      '6月',
      '7月',
    ]);
    expect(view.buildingTrend.map(({ grade }) => grade)).toEqual([
      'B+',
      'A-',
      'B-',
      'A+',
      'B-',
    ]);
  });
});
