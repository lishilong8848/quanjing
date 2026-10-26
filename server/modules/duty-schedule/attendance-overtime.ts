import {
  extractDisplayText,
  getRecordId,
  normalizeBuildingForFrontend,
  type BitableRecordItem,
} from '@server/common/feishu/bitable-direct-read';
import type { AttendanceExpectation } from './attendance-automation.rules';

export const ATTENDANCE_OVERTIME_FIELDS = [
  '加班审批',
  '加班流程进展',
  '加班工作流状态',
  '加班确认',
  '加班人员',
  '加班人员姓名',
  '机楼',
  '加班开始时间',
  '加班结束时间',
  '实际加班开始时间',
  '实际加班结束时间',
  '实际加班时长',
];

/** Only completed approvals create obligations; confirmation replaces, rather than adds to, the planned window. */
export function buildApprovedOvertimeExpectations(
  records: readonly BitableRecordItem[],
  date: string,
  cutoff = '23:59:59',
): AttendanceExpectation[] {
  return records.flatMap((record) => {
    const fields = record.fields || {};
    if (
      text(fields.加班审批) !== '同意' ||
      !['已审批', '待确认', '已确认'].includes(text(fields.加班工作流状态)) ||
      !['已审批', '已确认'].includes(text(fields.加班流程进展))
    )
      return [];
    const confirmed = text(fields.加班工作流状态) === '已确认';
    if (
      confirmed &&
      fields.实际加班时长 !== '' &&
      fields.实际加班时长 != null &&
      Number(text(fields.实际加班时长)) === 0
    )
      return [];
    const start = timestamp(
      confirmed ? fields.实际加班开始时间 : fields.加班开始时间,
    );
    const end = timestamp(
      confirmed ? fields.实际加班结束时间 : fields.加班结束时间,
    );
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new Error(`已审批加班起止时间无效：${getRecordId(record)}`);
    const startAt = localTime(start),
      endAt = localTime(end);
    if (startAt.slice(0, 10) !== date && endAt.slice(0, 10) !== date) return [];
    const name = text(fields.加班人员姓名) || text(fields.加班人员);
    const building = normalizeBuildingForFrontend(text(fields.机楼));
    if (!name || !/^(building_[abcdeh]|station_110)$/.test(building))
      throw new Error(`已审批加班人员或楼栋无法核验：${getRecordId(record)}`);
    const hour = Number(startAt.slice(11, 13));
    const night = hour >= 18 || hour < 8;
    return (['OnDuty', 'OffDuty'] as const).flatMap((direction, index) => {
      const expectedAt = index === 0 ? startAt : endAt;
      if (expectedAt.slice(0, 10) !== date || expectedAt > `${date} ${cutoff}`)
        return [];
      return [
        {
          key: `${date}:${building}:overtime_${night ? 'night' : 'white'}:${direction}:${name}:${getRecordId(record)}`,
          name,
          building:
            building === 'station_110'
              ? '110站'
              : `${building.slice(-1).toUpperCase()}楼`,
          shiftLabel: night ? '夜班加班' : '白班加班',
          direction,
          expectedAt,
          status: 'overtime' as const,
        },
      ];
    });
  });
}

export function mergeOvertimeExpectations(
  regular: readonly AttendanceExpectation[],
  overtime: readonly AttendanceExpectation[],
): AttendanceExpectation[] {
  const key = (event: AttendanceExpectation) =>
    JSON.stringify([
      event.name.replace(/\s/g, ''),
      event.building,
      event.direction,
      event.expectedAt,
    ]);
  const merged = new Map(regular.map((event) => [key(event), event]));
  overtime.forEach((event) => {
    if (!merged.has(key(event))) merged.set(key(event), event);
  });
  return [...merged.values()];
}

const text = (value: unknown) => extractDisplayText(value, '').trim();
function timestamp(value: unknown): number {
  const raw = text(value);
  if (!raw) return Number.NaN;
  if (/^\d+$/.test(raw)) return Number(raw);
  return Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : raw.replace(' ', 'T') + '+08:00',
  );
}
function localTime(value: number): string {
  return new Date(value + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}
