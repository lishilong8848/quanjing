export interface ChartPoint {
  x: number;
  y: number;
}

export function buildSmoothLinePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return '';

  let path = `M ${points[0].x} ${points[0].y}`;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midX = (previous.x + current.x) / 2;

    path += ` C ${midX} ${previous.y} ${midX} ${current.y} ${current.x} ${current.y}`;
  }

  return path;
}

export function buildSmoothAreaPath(
  points: readonly ChartPoint[],
  baselineY: number,
): string {
  const linePath = buildSmoothLinePath(points);
  if (!linePath) return '';

  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

export function resolveRateLabelY(
  preferredY: number,
  occupiedYs: readonly number[],
  minY: number,
  maxY: number,
  clearance = 18,
): number {
  const lowerBound = Math.min(minY, maxY);
  const upperBound = Math.max(minY, maxY);
  const safeClearance = Math.max(0, clearance);
  const clampedPreferredY = Math.min(
    upperBound,
    Math.max(lowerBound, preferredY),
  );
  const isSafe = (candidateY: number) =>
    occupiedYs.every(
      (occupiedY) => Math.abs(candidateY - occupiedY) >= safeClearance,
    );

  if (isSafe(clampedPreferredY)) return clampedPreferredY;

  const candidates = [lowerBound, upperBound];
  for (const occupiedY of occupiedYs) {
    candidates.push(occupiedY - safeClearance, occupiedY + safeClearance);
  }

  const nearestSafeY = candidates
    .filter(
      (candidateY) =>
        candidateY >= lowerBound &&
        candidateY <= upperBound &&
        isSafe(candidateY),
    )
    .sort(
      (left, right) =>
        Math.abs(left - clampedPreferredY) -
          Math.abs(right - clampedPreferredY) || left - right,
    )[0];

  return nearestSafeY ?? clampedPreferredY;
}
