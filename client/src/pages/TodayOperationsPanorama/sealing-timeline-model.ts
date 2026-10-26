import type { SealingInfo } from '@shared/api.interface';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTES_PER_WEEK = 7 * 24 * 60;
const WEEKDAY_LABELS = [
  '周日',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
] as const;

export interface SealingTimelineSegment {
  key: string;
  recordKey: string;
  item: SealingInfo;
  startMinute: number;
  endMinute: number;
  leftPercent: number;
  widthPercent: number;
  startsBeforeWindow: boolean;
  endsAfterWindow: boolean;
  visibleTimeLabel: string;
}

export interface SealingTimelineDay {
  dateKey: string;
  dateLabel: string;
  weekdayLabel: string;
}

export type SealingTimelineModel =
  | {
      status: 'error';
      days: readonly SealingTimelineDay[];
      segments: readonly SealingTimelineSegment[];
    }
  | {
      status: 'ready';
      days: readonly SealingTimelineDay[];
      segments: readonly SealingTimelineSegment[];
    };

interface CalendarDate {
  year: number;
  monthIndex: number;
  day: number;
}

function parseBusinessDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, monthIndex, day));

  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== monthIndex ||
    calendarDate.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, monthIndex, day };
}

export function getSealingTimelineRecordKey(item: SealingInfo): string {
  return (
    item.bitableRecordId?.trim() ||
    item.id?.trim() ||
    `${item.startDate}\u0000${item.endDate}\u0000${item.sealingName.trim()}`
  );
}

function getShanghaiParts(timestamp: number) {
  const date = new Date(timestamp + SHANGHAI_OFFSET_MS);
  return {
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function formatTimeParts(parts: ReturnType<typeof getShanghaiParts>): string {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function formatDateParts(parts: ReturnType<typeof getShanghaiParts>): string {
  return `${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')}`;
}

function formatVisibleRange(startMs: number, endMs: number): string {
  const start = getShanghaiParts(startMs);
  const end = getShanghaiParts(endMs);
  const startDate = formatDateParts(start);
  const endDate = formatDateParts(end);
  return startDate === endDate
    ? `${startDate} ${formatTimeParts(start)}–${formatTimeParts(end)}`
    : `${startDate} ${formatTimeParts(start)}–${endDate} ${formatTimeParts(end)}`;
}

export function buildSealingTimelineModel(
  items: readonly SealingInfo[],
  businessDate: string,
): SealingTimelineModel {
  const parsedBusinessDate = parseBusinessDate(businessDate);
  if (!parsedBusinessDate) {
    return { status: 'error', days: [], segments: [] };
  }

  const calendarAnchorMs = Date.UTC(
    parsedBusinessDate.year,
    parsedBusinessDate.monthIndex,
    parsedBusinessDate.day + 1,
  );
  const windowStartMs = calendarAnchorMs - SHANGHAI_OFFSET_MS;
  const windowEndMs = windowStartMs + 7 * DAY_MS;
  const days = Array.from({ length: 7 }, (_, dayOffset) => {
    const calendarDate = new Date(calendarAnchorMs + dayOffset * DAY_MS);
    const year = calendarDate.getUTCFullYear();
    const month = calendarDate.getUTCMonth() + 1;
    const day = calendarDate.getUTCDate();
    return {
      dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      dateLabel: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
      weekdayLabel: WEEKDAY_LABELS[calendarDate.getUTCDay()],
    };
  });

  const segments = items
    .map((item): SealingTimelineSegment | null => {
      const itemStartMs = Date.parse(item.startDate);
      const itemEndMs = Date.parse(item.endDate);
      if (
        !Number.isFinite(itemStartMs) ||
        !Number.isFinite(itemEndMs) ||
        itemEndMs <= itemStartMs ||
        itemStartMs >= windowEndMs ||
        itemEndMs <= windowStartMs
      ) {
        return null;
      }

      const clippedStartMs = Math.max(itemStartMs, windowStartMs);
      const clippedEndMs = Math.min(itemEndMs, windowEndMs);
      const startMinute = (clippedStartMs - windowStartMs) / MINUTE_MS;
      const endMinute = (clippedEndMs - windowStartMs) / MINUTE_MS;
      const recordKey = getSealingTimelineRecordKey(item);

      return {
        key: `${recordKey}-${itemStartMs}-${itemEndMs}`,
        recordKey,
        item,
        startMinute,
        endMinute,
        leftPercent: (startMinute / MINUTES_PER_WEEK) * 100,
        widthPercent: ((endMinute - startMinute) / MINUTES_PER_WEEK) * 100,
        startsBeforeWindow: itemStartMs < windowStartMs,
        endsAfterWindow: itemEndMs > windowEndMs,
        visibleTimeLabel: formatVisibleRange(clippedStartMs, clippedEndMs),
      };
    })
    .filter((segment): segment is SealingTimelineSegment => segment !== null)
    .sort(
      (left, right) =>
        left.startMinute - right.startMinute ||
        left.endMinute - right.endMinute ||
        left.recordKey.localeCompare(right.recordKey, 'zh-CN'),
    );

  return { status: 'ready', days, segments };
}
