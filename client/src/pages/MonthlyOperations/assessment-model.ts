import type { AssessmentRow } from '@shared/monthly-operations-assessment.interface';
import { eventRepeatKey } from '@shared/monthly-operations-event-identity';

const EVENT_CLUSTER_WINDOW_MS = 60 * 60 * 1000;
const timingTags = ['响应超时', '确认超时'];
const incidentTitle = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/21V-[A-Z0-9-]+-20\d{6}-\d+$/i, '')
    .trim();
const incidentSource = (value: string) =>
  value.normalize('NFKC').match(/(21V-[A-Z0-9-]+)-20\d{6}-\d+$/i)?.[1]?.toUpperCase() ?? '';
const detailValue = (row: AssessmentRow, label: string) =>
  row.detail.find((item) => item.label === label)?.value ?? '';
const eventOccurredAt = (row: AssessmentRow) =>
  detailValue(row, '发生时间') || detailValue(row, '通知时间');
function eventClusterKey(row: AssessmentRow) {
  const place = detailValue(row, '位置')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!place || row.building === '未标注') return '';
  const description = incidentTitle(detailValue(row, '事件描述') || row.title);
  const fault =
    eventRepeatKey(description, row.building) ||
    description.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const source = incidentSource(row.title);
  return fault.length >= 2 ? `${row.building}|${place}|${source}|${fault}` : '';
}

/** 同位置同故障的一次集中发生按一组统计，原始记录仍留在组内。 */
export function groupEventTimingAnomalies(rows: AssessmentRow[]) {
  type Cluster = { start: number; rows: AssessmentRow[] };
  const byKey = new Map<string, Cluster[]>(),
    clusters: Cluster[] = [];
  const ordered = [...rows].sort(
    (a, b) =>
      Date.parse(eventOccurredAt(a)) - Date.parse(eventOccurredAt(b)) ||
      a.id.localeCompare(b.id),
  );
  ordered.forEach((row) => {
    const start = Date.parse(eventOccurredAt(row));
    const key = eventClusterKey(row);
    const matches = key && Number.isFinite(start) ? byKey.get(key) : undefined;
    const last = matches?.[matches.length - 1];
    if (last && start - last.start <= EVENT_CLUSTER_WINDOW_MS) {
      last.rows.push(row);
      return;
    }
    const cluster = { start, rows: [row] };
    clusters.push(cluster);
    if (key && Number.isFinite(start)) {
      byKey.set(key, [...(matches ?? []), cluster]);
    }
  });
  return clusters
    .filter(({ rows: group }) =>
      group.some((row) => row.tags.includes('处理异常')),
    )
    .map(({ rows: group }) => {
      const qualifying = group.filter((row) => row.tags.includes('处理异常'));
      const representative = qualifying[qualifying.length - 1];
      if (group.length === 1) return { ...representative };
      const details = timingTags.flatMap((label) => {
        const hits = qualifying.flatMap((row) =>
          row.detail
            .filter((item) => item.label === label)
            .map((item) => `${row.code || row.title}：${item.value}`),
        );
        return hits.length ? [{ label, value: hits.join('\n') }] : [];
      });
      return {
        ...representative,
        title: incidentTitle(representative.title),
        tags: [...new Set(qualifying.flatMap((row) => row.tags))],
        detail: [
          ...representative.detail.filter(
            (item) => !timingTags.includes(item.label),
          ),
          ...details,
          {
            label: '同段合并',
            value: `${group.length} 条事件，其中 ${qualifying.length} 条达到超时条件，按一组统计`,
          },
        ],
        groupedEvents: group.map((row) => ({
          id: row.id,
          code: row.code,
          title: row.title,
          occurredAt: eventOccurredAt(row),
          status: row.status,
          tags: row.tags.filter((tag) => timingTags.includes(tag)),
        })),
      };
    })
    .sort(
      (a, b) =>
        Date.parse(eventOccurredAt(b)) - Date.parse(eventOccurredAt(a)),
    );
}
export function assessmentScope(rows: AssessmentRow[], building: string) {
  return rows.filter((r) => building === 'all' || r.building === building);
}
export function assessmentFilter(
  rows: AssessmentRow[],
  tag = 'all',
  search = '',
  building = 'all',
) {
  return assessmentScope(rows, building)
    .filter(
      (r) =>
        (tag === 'all' ||
          (tag === 'done' && r.done) ||
          (tag === 'pending' && !r.done) ||
          r.tags.includes(tag)) &&
        (!search ||
          [
            r.title,
            r.code,
            r.building,
            r.status,
            ...r.tags,
            ...(r.groupedEvents?.flatMap((item) => [item.code, item.title]) ?? []),
          ]
            .join(' ')
            .toLowerCase()
            .includes(search.toLowerCase())),
    )
    .sort(
      (a, b) =>
        Number(b.tags.length > 0) - Number(a.tags.length > 0) ||
        Number(a.done) - Number(b.done) ||
        (b.date ?? '').localeCompare(a.date ?? ''),
    );
}
export function assessmentProgress(rows: AssessmentRow[]) {
  const valid = rows.filter(
    (r) =>
      r.planned !== null &&
      r.checked !== null &&
      r.approved !== null &&
      !r.tags.includes('数据待核对'),
  );
  return {
    planned: valid.reduce((n, r) => n + r.planned!, 0),
    checked: valid.reduce((n, r) => n + r.checked!, 0),
    approved: valid.reduce((n, r) => n + r.approved!, 0),
    valid: valid.length,
  };
}
