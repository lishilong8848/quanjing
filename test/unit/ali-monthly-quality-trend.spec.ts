import { buildMonthlyQualityTrendSummary } from '../../client/src/pages/RiskInspectionDashboard/monthly-quality-trend';

function point(month: string, grade: string) {
  const grades = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-'];
  const gradeRank = grades.indexOf(grade);
  return {
    year: '2026年',
    month,
    grade,
    gradeRank: gradeRank === -1 ? null : gradeRank,
  };
}

describe('monthly quality building trend summary', () => {
  test('summarizes net improvement and A- or better coverage', () => {
    const summary = buildMonthlyQualityTrendSummary('A楼', [
      point('3月', 'B-'),
      point('4月', 'B+'),
      point('5月', 'A-'),
      point('6月', 'A'),
      point('7月', 'A+'),
    ]);

    expect(summary.tone).toBe('positive');
    expect(summary.headline).toBe('整体提升 5 个等级');
    expect(summary.description).toContain('3月 B- 起步，7月 A+ 收官');
    expect(summary.description).toContain('3个月达到 A- 及以上');
  });

  test('summarizes a decline and identifies the best and lowest months', () => {
    const summary = buildMonthlyQualityTrendSummary('C楼', [
      point('3月', 'A+'),
      point('4月', 'A-'),
      point('5月', 'B+'),
      point('6月', 'B'),
      point('7月', 'B-'),
    ]);

    expect(summary.tone).toBe('negative');
    expect(summary.headline).toBe('整体下降 5 个等级');
    expect(summary.description).toContain('最佳为3月 A+');
    expect(summary.description).toContain('最低为7月 B-');
  });

  test('distinguishes stable ratings from a volatile flat result', () => {
    const stable = buildMonthlyQualityTrendSummary('B楼', [
      point('5月', 'A-'),
      point('6月', 'A-'),
      point('7月', 'A-'),
    ]);
    const volatile = buildMonthlyQualityTrendSummary('D楼', [
      point('5月', 'B+'),
      point('6月', 'A-'),
      point('7月', 'B+'),
    ]);

    expect(stable).toMatchObject({
      tone: 'stable',
      headline: '整体保持 A-',
    });
    expect(volatile).toMatchObject({
      tone: 'mixed',
      headline: '整体持平，期间有波动',
    });
  });

  test('reports missing ratings without treating them as a decline', () => {
    const summary = buildMonthlyQualityTrendSummary('E楼', [
      point('5月', ''),
      point('6月', 'B'),
      point('7月', 'B'),
    ]);

    expect(summary.tone).toBe('stable');
    expect(summary.headline).toBe('整体保持 B');
    expect(summary.description).toContain('1个月暂无评级');
  });

  test('returns a clear pending state when no month has a rating', () => {
    const summary = buildMonthlyQualityTrendSummary('H楼', [
      point('6月', ''),
      point('7月', ''),
    ]);

    expect(summary).toEqual({
      tone: 'pending',
      headline: '暂无可比较评级',
      description: 'H楼近月评级尚未形成，待评级表更新后生成趋势结论。',
    });
  });
});
