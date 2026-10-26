import type {
  MonthlyEnergyBuilding,
  MonthlyOperationsResourcesResponse,
} from '@shared/monthly-operations-resources.interface';

export function comparePue(
  data: MonthlyOperationsResourcesResponse | null,
  start: string,
  end: string,
  selected: MonthlyEnergyBuilding[],
) {
  const days =
    data?.energy.days.filter((p) => p.date >= start && p.date <= end) ?? [];
  const weighted = (points: typeof days) => {
    const valid = points.filter(
      (p) => p.pue !== null && p.pueWeight !== null && p.pueWeight > 0,
    );
    return valid.length
      ? valid.reduce((s, p) => s + p.pue! * p.pueWeight!, 0) /
          valid.reduce((s, p) => s + p.pueWeight!, 0)
      : null;
  };
  const dates = new Map<string, Set<string>>();
  for (const p of days)
    if (p.pue !== null && p.pueWeight !== null && p.pueWeight > 0) {
      if (!dates.has(p.date)) dates.set(p.date, new Set());
      dates.get(p.date)!.add(p.building);
    }
  const common = new Set(
    [...dates]
      .filter(([, buildings]) => selected.every((b) => buildings.has(b)))
      .map(([date]) => date),
  );
  const midpoint = new Date(
    Math.floor(
      (Date.parse(start + 'T00:00:00Z') + Date.parse(end + 'T00:00:00Z')) / 2,
    ),
  )
    .toISOString()
    .slice(0, 10);
  const rows = selected.map((building) => {
    const own = days.filter(
      (p) => p.building === building && common.has(p.date),
    );
    const first = weighted(own.filter((p) => p.date <= midpoint)),
      last = weighted(own.filter((p) => p.date > midpoint));
    return {
      building,
      value: weighted(own),
      first,
      last,
      delta: first !== null && last !== null ? last - first : null,
    };
  });
  const buildings = rows
    .filter((r) => r.building !== '园区' && r.value !== null)
    .sort((a, b) => a.value! - b.value!);
  return {
    rows,
    commonDays: selected.length ? common.size : 0,
    midpoint,
    low: buildings[0],
    high: buildings.at(-1),
    park: weighted(days.filter((p) => p.building === '园区')),
  };
}
