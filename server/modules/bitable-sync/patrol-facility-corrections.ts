import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDutyDailyReportStateDirectory } from '../duty-schedule/duty-daily-report-state-path';
import { extractDateTimeIso, extractDateValue, extractDisplayText, getRecordId, type BitableRecordItem } from '../../common/feishu/bitable-direct-read';

export const PUE_FIELD = 'PUE（数值）';
export const ENERGY_VALUE = '数值（3位小数点）-可编辑';
export const NON_IT_VALUE = '非IT用电量（万）-可编辑';
export const ENERGY_NUMERIC_FIELDS = [
  ENERGY_VALUE, NON_IT_VALUE, PUE_FIELD, '总用电量数值', 'IT用电量数值', '冷源用电数值', '末端空调数值',
] as const;
export const DAILY_ENERGY_CATEGORIES = [
  'PUE', '总用电量', 'IT用电量', '非生产用电（H楼+其他）', '电气损耗', '冷源用电', '末端空调用电', '辅助用电',
] as const;
export const WATER_DAILY_FIELDS = [
  '当日耗水总量（实际）', '当日耗水总量', '东区耗水量', '西区耗水量', 'WUE', '当日用电量',
] as const;
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });

export interface PatrolFacilityCorrection {
  date: string;
  building: string;
  previousDate: string;
  rawPue: number;
  pue: number;
  electricity: number;
  electricityRecordId: string;
  water: Record<string, number | null>;
  waterRecordId: string;
  energy: Record<string, Record<string, number | null>>;
  energyRecordIds: Record<string, string>;
}

let revision = 0;
export const patrolFacilityCorrectionRevision = () => revision;

function stateDirectory(): string {
  return join(resolveDutyDailyReportStateDirectory({
    configuredDirectory: process.env.DUTY_DAILY_REPORT_STATE_DIR,
  }), 'patrol-facility-corrections');
}

export function energyCategoryKey(fields: Record<string, unknown>): string {
  return JSON.stringify([extractDisplayText(fields['类型']), extractDisplayText(fields['汇总分类'])]);
}

export function facilityDataDate(field: unknown): string | null {
  const iso = extractDateTimeIso(field);
  return iso ? DAY_FORMAT.format(new Date(iso)) : extractDateValue(field);
}

export async function readPatrolFacilityCorrections(start: string, end: string): Promise<Map<string, PatrolFacilityCorrection>> {
  const directory = stateDirectory();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return new Map();
    throw error;
  }
  const entries = await Promise.all(names.flatMap((name) => {
    const match = /^(\d{4}-\d{2}-\d{2})-([ABC])\.json$/u.exec(name);
    if (!match || match[1] < start || match[1] > end) return [];
    const [, date, letter] = match;
    return [readFile(join(directory, name), 'utf8').then((body) => {
      const item = JSON.parse(body) as PatrolFacilityCorrection;
      if (item.date !== date || item.building !== `${letter}楼` || !Number.isFinite(item.pue) ||
          item.pue <= 0 || !Number.isFinite(item.electricity) || item.electricity < 0 ||
          !item.electricityRecordId || !item.waterRecordId || !item.energyRecordIds ||
          !hasNumericFields(item.water, WATER_DAILY_FIELDS) || !item.energy ||
          !Object.entries(item.energy).every(([key, fields]) => item.energyRecordIds[key] && hasNumericFields(fields, ENERGY_NUMERIC_FIELDS))) {
        throw new Error('巡视能耗修正记录无法核验');
      }
      return [`${item.date}:${item.building}`, item] as const;
    })];
  }));
  return new Map(entries);
}

function hasNumericFields(fields: Record<string, number | null> | undefined, names: readonly string[]): boolean {
  return Boolean(fields && names.every((name) => fields[name] === null || Number.isFinite(fields[name])));
}

export async function savePatrolFacilityCorrection(item: PatrolFacilityCorrection): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(item.date) || !/^[ABC]楼$/u.test(item.building)) throw new Error('巡视能耗修正标识无效');
  const directory = stateDirectory();
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${item.date}-${item.building[0]}.json`);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(item), { encoding: 'utf8', flag: 'wx', flush: true });
    await rename(temp, file);
    revision += 1;
  } finally {
    await rm(temp, { force: true });
  }
}

export function applyPatrolFacilityCorrection(
  records: BitableRecordItem[],
  source: 'energy' | 'electricity' | 'water',
  corrections: ReadonlyMap<string, PatrolFacilityCorrection>,
): BitableRecordItem[] {
  if (corrections.size === 0) return records;
  return records.map((row) => {
    const fields = row.fields ?? {};
    const date = facilityDataDate(fields[source === 'water' ? '执行日期' : '日期']);
    const correction = corrections.get(`${date}:${extractDisplayText(fields['楼栋'])}`);
    if (!correction) return row;
    if (source === 'electricity' && getRecordId(row) === correction.electricityRecordId && extractDisplayText(fields['项目']) === '变压器总进线') {
      return { ...row, fields: { ...fields, 用电量: correction.electricity } };
    }
    if (source === 'water' && getRecordId(row) === correction.waterRecordId && extractDisplayText(fields['类型']) === '水耗' && extractDisplayText(fields['频次']) === '日') {
      return { ...row, fields: { ...fields, ...Object.fromEntries(WATER_DAILY_FIELDS.map((field) => [field, correction.water[field]])) } };
    }
    if (source === 'energy') {
      const key = energyCategoryKey(fields);
      const corrected = getRecordId(row) === correction.energyRecordIds[key] ? correction.energy[key] : undefined;
      if (corrected) return { ...row, fields: { ...fields, [PUE_FIELD]: corrected[PUE_FIELD],
        [ENERGY_VALUE]: corrected[ENERGY_VALUE], '数值（3位小数点）': corrected[ENERGY_VALUE],
        [NON_IT_VALUE]: corrected[NON_IT_VALUE], '非IT用电量（万）': corrected[NON_IT_VALUE],
      } };
    }
    return row;
  });
}
