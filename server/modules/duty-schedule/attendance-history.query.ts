import { BadRequestException } from '@nestjs/common';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RANGE_DAYS = 366;

export interface AttendanceHistoryQuery {
  startDate: string;
  endDate: string;
  forceRefresh: boolean;
}

export function parseAttendanceHistoryQuery(
  from: string | undefined,
  through: string | undefined,
  refresh?: string | string[],
): AttendanceHistoryQuery {
  const start = parseDateKey(from, '开始日期');
  const end = parseDateKey(through, '结束日期');
  if (start.time > end.time) {
    throw new BadRequestException('开始日期不能晚于结束日期');
  }
  const inclusiveDays = Math.floor((end.time - start.time) / DAY_MS) + 1;
  if (inclusiveDays > MAX_RANGE_DAYS) {
    throw new BadRequestException('查询周期不能超过 366 天');
  }
  const refreshValues = Array.isArray(refresh) ? refresh : [refresh];
  return {
    startDate: from,
    endDate: through,
    forceRefresh: refreshValues.some((value) =>
      ['1', 'true'].includes(
        String(value || '')
          .trim()
          .toLowerCase(),
      ),
    ),
  };
}

function parseDateKey(
  value: string | undefined,
  label: string,
): { time: number } {
  if (!DATE_PATTERN.test(value || '')) {
    throw new BadRequestException(`${label}格式无效`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${label}无效`);
  }
  return { time };
}
