import type {
  EquipmentPatrolBuilding,
  EquipmentPatrolCategory,
  EquipmentPatrolExecutionRecord,
  EquipmentPatrolExecutionStatus,
  EquipmentPatrolQualityFlag,
} from '../../../shared/equipment-patrol-execution.interface';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const FIELD = {
  title: '标题（名称）',
  building: '楼栋',
  equipment: '设备',
  specialty: '专业',
  planStart: '计划开始时间',
  planEnd: '计划结束时间',
  actualStart: '实际开始时间',
  actualEnd: '实际结束时间',
  progress: '进度',
  status: '轮巡状态',
  content: '内容',
  updatedAt: '最后更新时间',
} as const;

const CATEGORY_RULES: Array<{
  category: EquipmentPatrolCategory;
  pattern: RegExp;
}> = [
  { category: '制冷单元', pattern: /制冷单元/ },
  { category: '辅助区域精密空调', pattern: /精密空调|风冷空调/ },
  { category: '二次泵', pattern: /二次泵/ },
  { category: '东西区变频补水机组', pattern: /补水/ },
  { category: '包间空调（备机）', pattern: /包间/ },
  { category: '水质循环', pattern: /水质循环/ },
];

interface ParsedDateField {
  iso: string | null;
  invalid: boolean;
}

export function mapEquipmentPatrolExecutionRecord(
  raw: BitableRecordItem,
): EquipmentPatrolExecutionRecord {
  const fields = raw.fields || {};
  const title = toText(fields[FIELD.title]);
  const equipment = toText(fields[FIELD.equipment]);
  const specialty = toText(fields[FIELD.specialty]);
  const progress = toText(fields[FIELD.progress]);
  const content = toText(fields[FIELD.content]);
  const building = resolveBuilding(fields[FIELD.building], title);
  const planStart = parseDateField(fields[FIELD.planStart]);
  const planEnd = parseDateField(fields[FIELD.planEnd]);
  const actualStart = parseDateField(fields[FIELD.actualStart]);
  const actualEnd = parseDateField(fields[FIELD.actualEnd]);
  const updatedAt = parseDateField(fields[FIELD.updatedAt]);
  const qualityFlags: EquipmentPatrolQualityFlag[] = [];

  if (building.source === 'title') qualityFlags.push('building_inferred');
  if (building.source === 'missing') qualityFlags.push('building_missing');
  if (isInvalidRange(planStart, planEnd))
    qualityFlags.push('plan_time_invalid');
  if (isInvalidRange(actualStart, actualEnd))
    qualityFlags.push('actual_time_invalid');
  if (
    hasActualTimeDrift(
      planStart.iso,
      planEnd.iso,
      actualStart.iso,
      actualEnd.iso,
    )
  ) {
    qualityFlags.push('actual_time_drift');
  }

  const searchableText = [title, equipment, specialty, progress, content].join(
    '\n',
  );

  return {
    recordId: String(raw.record_id || raw.id || ''),
    title,
    building: building.value,
    buildingSource: building.source,
    equipment,
    specialty,
    categories: classifyCategories(searchableText),
    planStart: planStart.iso,
    planEnd: planEnd.iso,
    actualStart: actualStart.iso,
    actualEnd: actualEnd.iso,
    progress,
    status: normalizeStatus(fields[FIELD.status]),
    content,
    updatedAt: updatedAt.iso,
    nonPlanned: /非计划(?:性)?/.test(searchableText),
    qualityFlags,
  };
}

export function mapEquipmentPatrolExecutionRecords(
  records: BitableRecordItem[],
): EquipmentPatrolExecutionRecord[] {
  return records.map(mapEquipmentPatrolExecutionRecord);
}

export function filterEquipmentPatrolExecutionRecordsByMonth(
  records: EquipmentPatrolExecutionRecord[],
  month: string,
): EquipmentPatrolExecutionRecord[] {
  return records.filter((record) => {
    const date = record.planStart || record.actualStart || record.updatedAt;
    return date ? getShanghaiMonth(date) === month : false;
  });
}

function resolveBuilding(
  rawBuilding: unknown,
  title: string,
): {
  value: EquipmentPatrolBuilding | null;
  source: EquipmentPatrolExecutionRecord['buildingSource'];
} {
  const fieldBuilding = normalizeBuilding(toText(rawBuilding));
  if (fieldBuilding) return { value: fieldBuilding, source: 'field' };

  const titleBuilding = normalizeBuilding(title);
  if (titleBuilding) return { value: titleBuilding, source: 'title' };

  return { value: null, source: 'missing' };
}

function normalizeBuilding(value: string): EquipmentPatrolBuilding | null {
  const match = value.toUpperCase().match(/(?:^|[^A-Z])([A-E])\s*(?:楼|栋)/);
  return match ? (`${match[1]}楼` as EquipmentPatrolBuilding) : null;
}

function classifyCategories(value: string): EquipmentPatrolCategory[] {
  const matches = CATEGORY_RULES.filter(({ pattern }) =>
    pattern.test(value),
  ).map(({ category }) => category);
  return matches.length > 0 ? matches : ['其他'];
}

function normalizeStatus(value: unknown): EquipmentPatrolExecutionStatus {
  const status = toText(value);
  if (status.includes('结束')) return '结束';
  if (status.includes('更新')) return '更新';
  if (status.includes('开始')) return '开始';
  return '未知';
}

function parseDateField(value: unknown): ParsedDateField {
  const scalar = firstScalar(value);
  if (scalar === null || scalar === undefined || scalar === '') {
    return { iso: null, invalid: false };
  }

  const iso = parseDateToIso(scalar);
  return { iso, invalid: iso === null };
}

function parseDateToIso(value: unknown): string | null {
  if (typeof value === 'number') {
    return dateFromTimestamp(value);
  }

  const text = toText(value).trim();
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) {
    const timestamp = Number(text) * (text.length === 10 ? 1000 : 1);
    return dateFromTimestamp(timestamp);
  }

  const localMatch = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (localMatch) {
    const [
      ,
      yearText,
      monthText,
      dayText,
      hourText = '0',
      minuteText = '0',
      secondText = '0',
    ] = localMatch;
    const parts = [
      Number(yearText),
      Number(monthText),
      Number(dayText),
      Number(hourText),
      Number(minuteText),
      Number(secondText),
    ] as const;
    if (!isValidLocalDate(...parts)) return null;
    const [year, month, day, hour, minute, second] = parts;
    return new Date(
      Date.UTC(year, month - 1, day, hour, minute, second) - SHANGHAI_OFFSET_MS,
    ).toISOString();
  }

  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isValidLocalDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return false;
  }
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
}

function dateFromTimestamp(timestamp: number): string | null {
  const date = new Date(timestamp);
  return Number.isFinite(timestamp) && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : null;
}

function isInvalidRange(start: ParsedDateField, end: ParsedDateField): boolean {
  if (start.invalid || end.invalid) return true;
  return Boolean(
    start.iso && end.iso && Date.parse(start.iso) > Date.parse(end.iso),
  );
}

function hasActualTimeDrift(
  planStart: string | null,
  planEnd: string | null,
  actualStart: string | null,
  actualEnd: string | null,
): boolean {
  return (
    hasPairDrift(planStart, actualStart) || hasPairDrift(planEnd, actualEnd)
  );
}

function hasPairDrift(planned: string | null, actual: string | null): boolean {
  return Boolean(
    planned &&
    actual &&
    Math.abs(Date.parse(actual) - Date.parse(planned)) > ONE_DAY_MS,
  );
}

function getShanghaiMonth(iso: string): string | null {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return null;
  const local = new Date(timestamp + SHANGHAI_OFFSET_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

function firstScalar(value: unknown): unknown {
  if (Array.isArray(value))
    return value.length > 0 ? firstScalar(value[0]) : null;
  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    for (const key of ['text', 'name', 'value']) {
      if (objectValue[key] !== undefined) return firstScalar(objectValue[key]);
    }
  }
  return value;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(toText).filter(Boolean).join('、');
  }
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    for (const key of ['text', 'name', 'value']) {
      if (objectValue[key] !== undefined) return toText(objectValue[key]);
    }
    return '';
  }
  return String(value).trim();
}
