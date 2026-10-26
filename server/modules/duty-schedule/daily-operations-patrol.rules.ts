import { createHash } from 'node:crypto';
import type {
  ChangeInfo,
  MonthlySchedule,
  SealingInfo,
} from '../../../shared/api.interface';
import type {
  TodayOperationsKpiBuilding,
  TodayOperationsKpiBuildingMetricHistoryPeriod,
} from '../../../shared/today-operations-kpi.interface';
import type { QWeatherWarningItem } from '../bitable-sync/bitable-sync.service';
import type {
  DailyOperationsPatrolCheckKey,
  DailyOperationsPatrolCheckResult,
  DailyOperationsPatrolFacilityMetric,
  DailyOperationsPatrolIssue,
} from './daily-operations-patrol.types';

const DAY_MS = 24 * 60 * 60 * 1_000;
const STAFF_SEPARATOR = /[\s、,，;；/]+/u;

export interface FacilityMetricInput {
  businessDate: string;
  metrics: DailyOperationsPatrolFacilityMetric[];
  thresholdPercent?: number;
  compareDays?: number;
}

export function detectFacilityMetricIssues(
  input: FacilityMetricInput,
): DailyOperationsPatrolCheckResult {
  const thresholdPercent = finiteNonNegative(input.thresholdPercent, 50);
  const compareDays = Math.max(1, Math.floor(finitePositive(input.compareDays, 2)));
  const requiredDates = Array.from(
    { length: compareDays + 1 },
    (_, index) => shiftDate(input.businessDate, -index - 1),
  );
  const issues: DailyOperationsPatrolIssue[] = [];
  let evaluated = 0;

  for (const metric of input.metrics) {
    const history = normalizedHistory(metric.history);
    const historyByDate = new Map(history.map((period) => [period.date, period]));
    const missingDates = requiredDates.filter((date) => !historyByDate.has(date));
    if (missingDates.length > 0) {
      issues.push(
        issue(
          'facility',
          `${missingDates.join('、')} ${metric.label}日数据缺失或不完整`,
          missingDates
            .map((date) => `${date} ${metric.label}未取得完整有效日数据`)
            .join('；'),
          missingDates[0],
          'unavailable',
          `${metric.key}:history:${missingDates.join(',')}`,
        ),
      );
      continue;
    }

    const [current, ...priorPeriods] = requiredDates.map(
      (date) => historyByDate.get(date)!,
    );
    const baselines = priorPeriods.slice(0, compareDays);
    for (const row of current.rows) {
      const baselineValues = baselines.map((period) =>
        period.rows.find((candidate) => candidate.building === row.building)?.value,
      );
      if (
        baselineValues.length !== compareDays ||
        baselineValues.some(
          (value) => value === undefined || !Number.isFinite(value) || value <= 0,
        )
      ) {
        issues.push(
          issue(
            'facility',
            `${metric.label}数据不足`,
            `${row.building}缺少前${compareDays}个有效日正数值`,
            current.date,
            'unavailable',
            `${metric.key}:${row.building}:baseline`,
          ),
        );
        continue;
      }
      if (!Number.isFinite(row.value)) {
        issues.push(
          issue(
            'facility',
            `${metric.label}数据不足`,
            `${row.building}当前值无效`,
            current.date,
            'unavailable',
            `${metric.key}:${row.building}:current`,
          ),
        );
        continue;
      }

      evaluated += 1;
      const baseline =
        (baselineValues as number[]).reduce((sum, value) => sum + value, 0) /
        compareDays;
      const changePercent = ((row.value - baseline) / baseline) * 100;
      if (Math.abs(changePercent) < thresholdPercent) continue;
      const direction = changePercent >= 0 ? '上升' : '下降';
      issues.push(
        issue(
          'facility',
          `${row.building} ${metric.label} ${direction} ${formatNumber(Math.abs(changePercent), 1)}%`,
          `${current.date} 当前 ${formatNumber(row.value, 3)}${metric.unit}，前${compareDays}日均值 ${formatNumber(baseline, 3)}${metric.unit}`,
          current.date,
          'warning',
          `${metric.key}:${row.building}:${current.date}`,
        ),
      );
    }
  }

  return finishCheck(
    'facility',
    '用电 / PUE / 水耗',
    issues,
    evaluated ? `已检查 ${evaluated} 个楼栋指标` : '未获得可判断指标',
  );
}

export function detectScheduleRisks(
  schedules: MonthlySchedule[],
  startDate: string,
  endDate: string,
): DailyOperationsPatrolCheckResult {
  assertDateRange(startDate, endDate);
  const assignments = new Map<
    string,
    { date: string; staff: string; shift: 'white' | 'night'; building: string }
  >();
  const relevantStart = shiftDate(startDate, -1);

  for (const row of schedules) {
    const date = normalizeDate(row.scheduleDate);
    const shift = normalizeShift(row.shift || row.shiftText || row.team || row.teamText);
    const building = cleanText(row.buildingText || row.building);
    if (!date || date < relevantStart || date > endDate || !shift || !building) {
      continue;
    }
    for (const staff of staffNames(row)) {
      assignments.set(`${date}|${staff}|${shift}|${building}`, {
        date,
        staff,
        shift,
        building,
      });
    }
  }

  const byStaffDate = new Map<
    string,
    Array<{ date: string; staff: string; shift: 'white' | 'night'; building: string }>
  >();
  for (const assignment of assignments.values()) {
    const key = `${assignment.staff}|${assignment.date}`;
    const values = byStaffDate.get(key) || [];
    values.push(assignment);
    byStaffDate.set(key, values);
  }

  const found = new Map<string, DailyOperationsPatrolIssue>();
  for (const date of datesBetween(startDate, endDate)) {
    const previousDate = shiftDate(date, -1);
    const people = new Set(
      [...assignments.values()].map((assignment) => assignment.staff),
    );
    for (const staff of people) {
      const current = byStaffDate.get(`${staff}|${date}`) || [];
      const whites = current.filter((item) => item.shift === 'white');
      const nights = current.filter((item) => item.shift === 'night');
      for (const white of whites) {
        for (const night of nights) {
          const key = `${date}|${staff}|white-night|${white.building}|${night.building}`;
          found.set(
            key,
            issue(
              'schedule',
              `${staff}：白班后接夜班`,
              `${date} ${white.building}白班 → ${night.building}夜班`,
              date,
              'warning',
              key,
            ),
          );
        }
      }
      const previousNights = (
        byStaffDate.get(`${staff}|${previousDate}`) || []
      ).filter((item) => item.shift === 'night');
      for (const previousNight of previousNights) {
        for (const white of whites) {
          const key = `${date}|${staff}|night-white|${previousNight.building}|${white.building}`;
          found.set(
            key,
            issue(
              'schedule',
              `${staff}：夜班后接白班`,
              `${previousDate} ${previousNight.building}夜班 → ${date} ${white.building}白班`,
              date,
              'warning',
              key,
            ),
          );
        }
      }
    }
  }

  return finishCheck(
    'schedule',
    '排班连班风险',
    sortIssues([...found.values()]),
    `检查范围 ${startDate} 至 ${endDate}`,
  );
}

export function detectPlanConflicts(
  changes: ChangeInfo[],
  sealings: SealingInfo[],
  startDate: string,
  endDate: string,
): DailyOperationsPatrolCheckResult {
  assertDateRange(startDate, endDate);
  const sealingWindows = sealings
    .map((sealing) => ({
      sealing,
      start: parseDateTime(sealing.startDate),
      end: parseDateTime(sealing.endDate),
    }))
    .filter(
      (item): item is { sealing: SealingInfo; start: Date; end: Date } =>
        Boolean(item.start && item.end && item.end > item.start),
    );
  const found = new Map<string, DailyOperationsPatrolIssue>();

  for (const date of datesBetween(startDate, endDate)) {
    const [dayStart, dayEnd] = dayWindow(date);
    const activeSealing = sealingWindows
      .filter((item) => item.start < dayEnd && item.end > dayStart)
      .sort((left, right) => left.start.getTime() - right.start.getTime())[0];
    if (!activeSealing) continue;

    for (const change of changes) {
      const window = changeWindowOnDate(change, date, startDate);
      if (!window) continue;
      if (window.start >= activeSealing.end || window.end <= activeSealing.start) {
        continue;
      }
      const title = cleanText(change.title) || '未命名变更';
      const sealingName =
        cleanText(activeSealing.sealing.sealingName) || '未命名封网';
      const key = [
        date,
        change.id || change.bitableRecordId || title,
        activeSealing.sealing.id ||
          activeSealing.sealing.bitableRecordId ||
          sealingName,
      ].join('|');
      found.set(
        key,
        issue(
          'plan',
          `${title} 与封网冲突`,
          `${sealingName}；变更窗口 ${formatShanghaiTime(window.start)}-${formatShanghaiTime(window.end)}`,
          date,
          'warning',
          key,
        ),
      );
    }
  }

  return finishCheck(
    'plan',
    '计划冲突',
    sortIssues([...found.values()]),
    `检查范围 ${startDate} 至 ${endDate}`,
  );
}

export function detectWeatherAlerts(
  warnings: QWeatherWarningItem[],
): DailyOperationsPatrolCheckResult {
  const issues = warnings
    .filter((warning) => cleanText(warning.status) !== '解除')
    .map((warning, index) => {
      const title = cleanText(warning.title) || '气象告警';
      const detail = [cleanText(warning.level), cleanText(warning.text)]
        .filter(Boolean)
        .join('；');
      const date = normalizeDate(warning.pubTime) || '';
      return issue(
        'weather',
        title,
        detail || '当前告警仍在生效',
        date,
        'warning',
        warning.id || `${title}:${date}:${index}`,
      );
    });
  return finishCheck(
    'weather',
    '天气告警',
    sortIssues(issues),
    '已读取当前有效天气告警',
  );
}

export function unavailablePatrolCheck(
  key: DailyOperationsPatrolCheckKey,
  label: string,
  error: unknown,
): DailyOperationsPatrolCheckResult {
  const detail = safeError(error);
  return {
    key,
    label,
    status: 'unavailable',
    count: 1,
    summary: '数据读取失败',
    issues: [
      issue(
        key,
        `${label}数据不可用`,
        detail,
        '',
        'unavailable',
        `${key}:${detail}`,
      ),
    ],
  };
}

function finishCheck(
  key: DailyOperationsPatrolCheckKey,
  label: string,
  issues: DailyOperationsPatrolIssue[],
  normalSummary: string,
): DailyOperationsPatrolCheckResult {
  const unique = new Map(issues.map((item) => [item.id, item]));
  const values = sortIssues([...unique.values()]);
  const hasWarning = values.some((item) => item.severity === 'warning');
  const hasUnavailable = values.some((item) => item.severity === 'unavailable');
  return {
    key,
    label,
    status: hasWarning ? 'alert' : hasUnavailable ? 'unavailable' : 'normal',
    count: values.length,
    summary: values.length ? `${values.length} 项需关注` : normalSummary,
    issues: values,
  };
}

function issue(
  check: DailyOperationsPatrolCheckKey,
  title: string,
  detail: string,
  date: string,
  severity: DailyOperationsPatrolIssue['severity'],
  stableKey: string,
): DailyOperationsPatrolIssue {
  return {
    id: createHash('sha256')
      .update(`daily-operations-patrol:${check}:${stableKey}`)
      .digest('hex'),
    check,
    title: cleanText(title).slice(0, 160),
    detail: cleanText(detail).slice(0, 500),
    date: normalizeDate(date) || '',
    severity,
  };
}

function normalizedHistory(
  history: TodayOperationsKpiBuildingMetricHistoryPeriod[] | undefined,
): TodayOperationsKpiBuildingMetricHistoryPeriod[] {
  return [...(history || [])]
    .filter((period) => normalizeDate(period.date))
    .sort((left, right) => right.date.localeCompare(left.date))
    .map((period) => ({
      date: period.date,
      rows: period.rows.filter(
        (row): row is { building: TodayOperationsKpiBuilding; value: number } =>
          Boolean(row.building) && Number.isFinite(row.value),
      ),
    }));
}

function staffNames(row: MonthlySchedule): string[] {
  const source =
    cleanText(row.actualDutyStaff) ||
    (Array.isArray(row.dutyStaffActual)
      ? row.dutyStaffActual.map(cleanText).filter(Boolean).join('、')
      : '') ||
    cleanText(row.personText);
  return [...new Set(source.split(STAFF_SEPARATOR).map(cleanText).filter(Boolean))];
}

function normalizeShift(value: unknown): 'white' | 'night' | null {
  const text = cleanText(value).toLocaleLowerCase();
  if (!text || text.includes('long_white') || text.includes('longwhite') || text.includes('长白')) {
    return null;
  }
  if (text.includes('night') || text.includes('夜')) return 'night';
  if (text.includes('white') || text.includes('白')) return 'white';
  return null;
}

function changeWindowOnDate(
  change: ChangeInfo,
  date: string,
  referenceDate: string,
): { start: Date; end: Date } | null {
  const actualStart = parseDateTime(change.actualStartDate);
  const actualEnd = parseDateTime(change.actualEndDate);
  const plannedStart = parseDateTime(change.startDate);
  const plannedEnd = parseDateTime(change.endDate || change.startDate);
  const useActual = date <= referenceDate;
  if (useActual && !actualStart) return null;
  const rawStart = useActual ? actualStart : plannedStart;
  const rawEnd = useActual
    ? actualEnd || plannedEnd || actualStart
    : plannedEnd;
  if (!rawStart || !rawEnd) return null;
  const normalizedEnd =
    rawEnd > rawStart ? rawEnd : new Date(rawStart.getTime() + 60_000);
  const [dayStart, dayEnd] = dayWindow(date);
  let start = new Date(Math.max(rawStart.getTime(), dayStart.getTime()));
  let end = new Date(Math.min(normalizedEnd.getTime(), dayEnd.getTime()));
  if (start >= end) return null;
  if (!useActual || normalizedEnd.getTime() - rawStart.getTime() > 12 * 60 * 60 * 1_000) {
    const workStart = parseDateTime(`${date}T09:00:00+08:00`)!;
    const workEnd = parseDateTime(`${date}T18:00:00+08:00`)!;
    start = new Date(Math.max(start.getTime(), workStart.getTime()));
    end = new Date(Math.min(end.getTime(), workEnd.getTime()));
    if (start >= end) return null;
  }
  return { start, end };
}

function dayWindow(date: string): [Date, Date] {
  const start = parseDateTime(`${date}T00:00:00+08:00`);
  if (!start) throw new TypeError(`无效日期：${date}`);
  return [start, new Date(start.getTime() + DAY_MS)];
}

function datesBetween(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  for (let value = startDate; value <= endDate; value = shiftDate(value, 1)) {
    result.push(value);
  }
  return result;
}

export function shiftDate(date: string, days: number): string {
  const normalized = normalizeDate(date);
  if (!normalized) throw new TypeError(`无效日期：${date}`);
  const [year, month, day] = normalized.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function assertDateRange(startDate: string, endDate: string): void {
  if (!normalizeDate(startDate) || !normalizeDate(endDate) || endDate < startDate) {
    throw new TypeError('巡视日期范围无效');
  }
}

function normalizeDate(value: unknown): string | null {
  const text = cleanText(value);
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(text);
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === match[1]
    ? match[1]
    : null;
}

function parseDateTime(value: unknown): Date | null {
  const text = cleanText(value);
  if (!text) return null;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/u.test(text) ? `${text}T00:00:00+08:00` : text);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function formatShanghaiTime(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function sortIssues(
  values: DailyOperationsPatrolIssue[],
): DailyOperationsPatrolIssue[] {
  return values.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.title.localeCompare(right.title, 'zh-CN'),
  );
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\t]+/gu, ' ').trim();
}

function safeError(error: unknown): string {
  return cleanText(error instanceof Error ? error.message : error)
    .replace(
      /(app[_-]?secret|tenant[_-]?access[_-]?token|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;}&]+/giu,
      '$1=***',
    )
    .slice(0, 300) || '未知错误';
}

function formatNumber(value: number, precision: number): string {
  return Number(value.toFixed(precision)).toString();
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}
