import type { MonthlyQualityBuildingTrendPoint } from './monthly-quality-model';

export type MonthlyQualityTrendTone =
  | 'positive'
  | 'negative'
  | 'stable'
  | 'mixed'
  | 'pending';

export interface MonthlyQualityTrendSummary {
  tone: MonthlyQualityTrendTone;
  headline: string;
  description: string;
}

export function buildMonthlyQualityTrendSummary(
  building: string,
  points: MonthlyQualityBuildingTrendPoint[],
): MonthlyQualityTrendSummary {
  const ratedPoints = points.filter(
    (
      point,
    ): point is MonthlyQualityBuildingTrendPoint & { gradeRank: number } =>
      point.gradeRank !== null && Boolean(point.grade),
  );

  if (ratedPoints.length === 0) {
    return {
      tone: 'pending',
      headline: '暂无可比较评级',
      description: `${building}近月评级尚未形成，待评级表更新后生成趋势结论。`,
    };
  }

  const first = ratedPoints[0];
  const last = ratedPoints[ratedPoints.length - 1];
  const netChange = first.gradeRank - last.gradeRank;
  const hasIntermediateMovement = ratedPoints.some(
    (point, index) =>
      index > 0 && point.gradeRank !== ratedPoints[index - 1].gradeRank,
  );
  const best = ratedPoints.reduce((current, point) =>
    point.gradeRank < current.gradeRank ? point : current,
  );
  const lowest = ratedPoints.reduce((current, point) =>
    point.gradeRank > current.gradeRank ? point : current,
  );
  const benchmarkMonthCount = ratedPoints.filter(
    ({ gradeRank }) => gradeRank <= 2,
  ).length;
  const missingMonthCount = points.length - ratedPoints.length;

  let tone: MonthlyQualityTrendTone = 'stable';
  let headline = `整体保持 ${last.grade}`;
  if (netChange > 0) {
    tone = 'positive';
    headline = `整体提升 ${netChange} 个等级`;
  } else if (netChange < 0) {
    tone = 'negative';
    headline = `整体下降 ${Math.abs(netChange)} 个等级`;
  } else if (hasIntermediateMovement) {
    tone = 'mixed';
    headline = '整体持平，期间有波动';
  }

  const details = [
    `${first.month} ${first.grade} 起步，${last.month} ${last.grade} 收官`,
    `最佳为${best.month} ${best.grade}，最低为${lowest.month} ${lowest.grade}`,
    `${benchmarkMonthCount}个月达到 A- 及以上`,
  ];
  if (missingMonthCount > 0) {
    details.push(`${missingMonthCount}个月暂无评级`);
  }

  return {
    tone,
    headline,
    description: `${details.join('；')}。`,
  };
}
