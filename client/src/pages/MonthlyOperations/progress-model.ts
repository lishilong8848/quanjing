import type { ZhihangChangeProgress } from '@shared/monthly-operations-progress.interface';

export type ProgressFocus = 'all' | 'customer' | 'post' | 'delayed';
export const PROGRESS_FOCUS = {
  all: '全部',
  customer: '客服审批',
  post: '实施后审批',
  delayed: '计划延期',
} as const;
const laterBy = (original: string | null, deferred: string | null) =>
  original && deferred
    ? Math.max(0, Date.parse(deferred) - Date.parse(original))
    : 0;

export function progressAttention(row: ZhihangChangeProgress) {
  const delayMs = Math.max(
    laterBy(row.plannedStart, row.deferredStart),
    laterBy(row.plannedEnd, row.deferredEnd),
  );
  return {
    customer: /客服.*审批/.test(row.node),
    post: /实施后.*审批/.test(row.node),
    delayed: delayMs > 0 || /计划.*延期|延期.*计划/.test(row.node),
    delayMs,
  };
}

export function delayLabel(row: ZhihangChangeProgress) {
  const { delayMs } = progressAttention(row);
  if (!delayMs) return '计划延期';
  const days = delayMs / 86400000;
  return `顺延 ${days >= 1 ? `${Number(days.toFixed(1))} 天` : `${Number((days * 24).toFixed(1))} 小时`}`;
}

function day(iso: string) {
  return new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10);
}

export function progressScope(
  rows: ZhihangChangeProgress[],
  start: string,
  end: string,
  building: string,
  history = false,
) {
  return rows
    .filter((row) => {
      if (building !== 'all' && !row.buildings.includes(building)) return false;
      if (history) return true;
      const begins = row.deferredStart || row.plannedStart;
      const ends = row.deferredEnd || row.plannedEnd || begins;
      return !!begins && !!ends && day(begins) <= end && day(ends) >= start;
    })
    .sort((a, b) => {
      const score = (r: ZhihangChangeProgress) => {
        const f = progressAttention(r);
        return (
          Number(f.customer) * 4 + Number(f.post) * 4 + Number(f.delayed) * 2
        );
      };
      return (
        score(b) - score(a) ||
        (b.deferredStart || b.plannedStart || '').localeCompare(
          a.deferredStart || a.plannedStart || '',
        ) ||
        a.id.localeCompare(b.id)
      );
    });
}

export function filterProgress(
  rows: ZhihangChangeProgress[],
  focus: ProgressFocus,
  query: string,
) {
  const word = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (focus === 'all' || progressAttention(row)[focus]) &&
      (!word ||
        [
          row.code,
          row.workOrder,
          row.title,
          row.node,
          row.status,
          row.buildings.join(' '),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(word)),
  );
}
