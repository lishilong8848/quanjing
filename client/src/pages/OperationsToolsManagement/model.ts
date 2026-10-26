import {
  TOOL_BUILDINGS,
  type OperationsTool,
  type OperationsToolFlow,
  type OperationsToolsSnapshot,
} from '@shared/operations-tools.interface';

export function chinaToday(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
export function daysRemaining(
  date: string | null,
  today: string,
): number | null {
  if (!date) return null;
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86400000,
  );
  return Number.isFinite(days) ? days : null;
}
export function dueLabel(date: string | null, today: string): string {
  const days = daysRemaining(date, today);
  return days === null
    ? '待完善'
    : days < 0
      ? `逾期 ${-days} 天`
      : days === 0
        ? '今日到期'
        : `剩余 ${days} 天`;
}
export function deriveTools(
  snapshot: Pick<OperationsToolsSnapshot, 'tools' | 'flows'>,
  building: string,
  search: string,
  today: string,
) {
  const keyword = search.trim().toLocaleLowerCase();
  const tools = snapshot.tools.filter(
    (t) =>
      (!building || t.building === building) &&
      (!keyword ||
        [t.name, t.model, t.code, t.place]
          .join(' ')
          .toLocaleLowerCase()
          .includes(keyword)),
  );
  const ids = new Set(tools.map((t) => t.id));
  const flows = snapshot.flows.filter(
    (f) =>
      (!building ||
        f.building === building ||
        f.toolIds.some((id) => ids.has(id))) &&
      (!keyword ||
        f.toolIds.some((id) => ids.has(id)) ||
        [f.name, f.code, f.reason]
          .join(' ')
          .toLocaleLowerCase()
          .includes(keyword)),
  );
  const activeQuality = new Set(
    snapshot.flows
      .filter(
        (f) =>
          f.kind === 'quality' && !['检修完成', '报废完成'].includes(f.status),
      )
      .flatMap((f) => f.toolIds),
  );
  const borrowed = new Set(
    snapshot.flows
      .filter((f) => f.kind === 'borrow' && f.status === '工具已出库')
      .flatMap((f) => f.toolIds),
  );
  const near = (date: string | null): boolean => {
    const n = daysRemaining(date, today);
    return n !== null && n < 30;
  };
  const groups = {
    total: tools,
    quality: tools.filter(
      (t) =>
        !t.scrapStatus &&
        (t.conclusion === '不合格' || activeQuality.has(t.id)),
    ),
    borrow: tools.filter((t) => borrowed.has(t.id)),
    maintenance: tools.filter((t) => !t.scrapStatus && near(t.maintenanceDue)),
    inspection: tools.filter((t) => !t.scrapStatus && near(t.inspectionDue)),
  };
  const qualityIds = new Set(groups.quality.map((t) => t.id));
  const buildings = TOOL_BUILDINGS.filter((b) => !building || b === building)
    .map((b) => ({
      building: b,
      tools: tools.filter((t) => t.building === b),
      quality: groups.quality.filter((t) => t.building === b),
    }))
    .sort((a, b) => b.tools.length - a.tools.length);
  const concerns = [...tools].sort(
    (a, b) =>
      Number(qualityIds.has(b.id)) - Number(qualityIds.has(a.id)) ||
      b.issues.length - a.issues.length ||
      a.name.localeCompare(b.name, 'zh-CN'),
  );
  const checkNames = ['外观完好无破损', '配件齐全', '功能正常', '清洁情况'];
  const problemIds = new Map(
    checkNames.map((check) => [check, new Set<string>()]),
  );
  for (const flow of snapshot.flows) {
    if (
      flow.kind !== 'quality' ||
      ['检修完成', '报废完成'].includes(flow.status)
    )
      continue;
    for (const check of checkNames) {
      if (flow.checks[check] === false)
        for (const id of flow.toolIds) problemIds.get(check)!.add(id);
    }
  }
  const problems = checkNames
    .map((check, index) => ({
      label: ['外观破损', '配件缺失', '功能异常', '清洁异常'][index],
      check,
      tools: groups.quality.filter(
        (t) => t.checks[check] === false || problemIds.get(check)!.has(t.id),
      ),
    }))
    .sort((a, b) => b.tools.length - a.tools.length);
  return { tools, flows, groups, buildings, concerns, problems };
}
export type ToolMetric = keyof ReturnType<typeof deriveTools>['groups'];
export function flowToolName(
  flow: OperationsToolFlow,
  tools: OperationsTool[],
): string {
  const names = flow.toolIds
    .map((id) => tools.find((t) => t.id === id)?.name)
    .filter(Boolean);
  return names.length ? names.join('、') : flow.name || '关联工具待完善';
}
