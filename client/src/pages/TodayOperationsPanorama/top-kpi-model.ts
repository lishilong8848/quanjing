import type { TodayOperationsKpiResponse } from '@shared/today-operations-kpi.interface';
import {
  PANORAMA_KPIS,
  type PanoramaDirection,
  type PanoramaKpi,
} from './data';

type TopKpiMetrics = TodayOperationsKpiResponse['metrics'];
type TopKpiMetricKey = keyof TopKpiMetrics;
type TopKpiDetails = TodayOperationsKpiResponse['details'];
export type OnDutyShift = 'white' | 'night';

export interface OnDutyPersonModel {
  name: string;
  status: string;
  statusLabel: string;
  onDuty: boolean;
  relatedStaff: string[];
}

export interface OnDutyBuildingModel {
  building: string;
  buildingName: string;
  people: OnDutyPersonModel[];
}

export interface OnDutyShiftModel {
  shift: OnDutyShift;
  shiftLabel: string;
  total: number | null;
  dataAvailable: boolean;
  buildings: OnDutyBuildingModel[];
}

export interface OnDutyDialogModel {
  total: number;
  whiteShiftTotal: number;
  nightShiftTotal: number | null;
  date: string | null;
  isSummaryOnly: boolean;
  shifts: OnDutyShiftModel[];
}

interface MetricFormat {
  metric: TopKpiMetricKey;
  valueDigits: number;
  deltaDigits: number;
  deltaSuffix: string;
}

const METRIC_FORMATS: Record<string, MetricFormat> = {
  'running-days': {
    metric: 'safeOperationDays',
    valueDigits: 0,
    deltaDigits: 0,
    deltaSuffix: '',
  },
  'on-duty': {
    metric: 'onDutyPeople',
    valueDigits: 0,
    deltaDigits: 0,
    deltaSuffix: '',
  },
  'average-pue': {
    metric: 'averagePue',
    valueDigits: 3,
    deltaDigits: 3,
    deltaSuffix: '',
  },
  'it-load': {
    metric: 'itLoadRate',
    valueDigits: 1,
    deltaDigits: 1,
    deltaSuffix: '%',
  },
  electricity: {
    metric: 'electricityKwh',
    valueDigits: 0,
    deltaDigits: 0,
    deltaSuffix: ' KWh',
  },
  water: {
    metric: 'waterTons',
    valueDigits: 1,
    deltaDigits: 1,
    deltaSuffix: ' t',
  },
};

const shanghaiHourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  hourCycle: 'h23',
});

export function resolveShanghaiOnDutyLeadShift(
  now: Date = new Date(),
): OnDutyShift {
  const hour = Number(shanghaiHourFormatter.format(now));
  return hour >= 18 || hour < 9 ? 'night' : 'white';
}

function orderShifts<T extends { shift: OnDutyShift }>(
  shifts: readonly T[],
  leadShift: OnDutyShift,
): T[] {
  return [...shifts].sort((left, right) => {
    if (left.shift === right.shift) return 0;
    return left.shift === leadShift ? -1 : 1;
  });
}

function formatNumber(value: number, digits: number): string {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: true,
  }).format(value);
}

function formatDateCaption(date: string | null): string {
  const match = date?.match(/^\d{4}-(\d{2})-(\d{2})/);
  return match ? `截至 ${match[1]}-${match[2]}` : '暂无上期对比';
}

function compareMetric(
  value: number,
  previousValue: number | null,
  date: string | null,
  format: MetricFormat,
): Pick<PanoramaKpi, 'comparison' | 'direction'> {
  if (previousValue === null || !Number.isFinite(previousValue)) {
    return {
      comparison: formatDateCaption(date),
      direction: 'neutral',
    };
  }

  const rawDelta = value - previousValue;
  const precision = 10 ** format.deltaDigits;
  const roundedDelta = Math.round(rawDelta * precision) / precision;
  if (Object.is(roundedDelta, 0) || Object.is(roundedDelta, -0)) {
    return {
      comparison: '较昨日持平',
      direction: 'neutral',
    };
  }

  const direction: PanoramaDirection = roundedDelta > 0 ? 'up' : 'down';
  const arrow = direction === 'up' ? '↑' : '↓';
  return {
    comparison: `较昨日 ${arrow} ${formatNumber(
      Math.abs(roundedDelta),
      format.deltaDigits,
    )}${format.deltaSuffix}`,
    direction,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function normalizePerson(value: unknown): OnDutyPersonModel | null {
  const person = asRecord(value);
  const name = typeof person?.name === 'string' ? person.name.trim() : '';
  if (!name) return null;

  return {
    name,
    status:
      typeof person?.status === 'string' && person.status.trim()
        ? person.status.trim()
        : 'on_duty',
    statusLabel:
      typeof person?.statusLabel === 'string' && person.statusLabel.trim()
        ? person.statusLabel.trim()
        : '在岗',
    onDuty: person?.onDuty !== false,
    relatedStaff: stringArray(person?.relatedStaff),
  };
}

function normalizeBuildings(value: unknown): OnDutyBuildingModel[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((rawBuilding) => {
    const building = asRecord(rawBuilding);
    if (!building) return [];
    const buildingCode =
      typeof building.building === 'string' ? building.building.trim() : '';
    const buildingName =
      typeof building.buildingName === 'string'
        ? building.buildingName.trim()
        : buildingCode;
    const normalizedPeople = Array.isArray(building.people)
      ? building.people
          .map(normalizePerson)
          .filter((person): person is OnDutyPersonModel => person !== null)
      : [];
    const people =
      normalizedPeople.length > 0
        ? normalizedPeople
        : stringArray(building.staff).map((name) => ({
            name,
            status: 'on_duty',
            statusLabel: '在岗',
            onDuty: true,
            relatedStaff: [],
          }));

    return [
      {
        building: buildingCode || buildingName,
        buildingName: buildingName || buildingCode || '未分配楼栋',
        people,
      },
    ];
  });
}

function readOnDutyDetails(
  details?: TopKpiDetails,
): Record<string, unknown> | null {
  return asRecord(details?.onDutyPeople);
}

export function buildTopKpis(
  metrics: TopKpiMetrics,
  details?: TopKpiDetails,
  onDutyLeadShift: OnDutyShift = 'white',
): PanoramaKpi[] {
  return PANORAMA_KPIS.map((template) => {
    const format = METRIC_FORMATS[template.key];
    const metric = metrics[format.metric];
    const onDutyDetails =
      template.key === 'on-duty' ? readOnDutyDetails(details) : null;
    const isDailyShifts = onDutyDetails?.scope === 'daily_shifts';
    const whiteShiftTotal = isDailyShifts
      ? finiteNumber(onDutyDetails?.whiteShiftTotal)
      : finiteNumber(onDutyDetails?.total);
    const nightShiftTotal = isDailyShifts
      ? finiteNumber(onDutyDetails?.nightShiftTotal)
      : null;
    const detailValue = whiteShiftTotal;
    const value = Number.isFinite(detailValue)
      ? (detailValue as number)
      : Number.isFinite(metric.value)
        ? metric.value
        : 0;
    const date =
      template.key === 'on-duty'
        ? typeof onDutyDetails?.date === 'string'
          ? onDutyDetails.date
          : metric.date
        : metric.date;

    if (template.key === 'on-duty' && isDailyShifts) {
      const totals: Record<OnDutyShift, number> = {
        white: value,
        night: nightShiftTotal ?? 0,
      };
      const shiftLabels: Record<OnDutyShift, string> = {
        white: '白班',
        night: '夜班',
      };
      const shiftOrder: readonly OnDutyShift[] =
        onDutyLeadShift === 'night' ? ['night', 'white'] : ['white', 'night'];
      return {
        ...template,
        value: formatNumber(totals[onDutyLeadShift], format.valueDigits),
        comparison: shiftOrder
          .map(
            (shift) =>
              `${shiftLabels[shift]} ${formatNumber(totals[shift], 0)}人`,
          )
          .join(' · '),
        direction: 'neutral',
      };
    }

    return {
      ...template,
      value: formatNumber(value, format.valueDigits),
      ...compareMetric(value, metric.previousValue, date, format),
    };
  });
}

export function buildOnDutyDialogModel(
  response: TodayOperationsKpiResponse,
  onDutyLeadShift: OnDutyShift = 'white',
): OnDutyDialogModel {
  const details = asRecord(response.details?.onDutyPeople);
  const metricTotal = finiteNumber(response.metrics.onDutyPeople.value) ?? 0;
  const date =
    typeof details?.date === 'string'
      ? details.date
      : response.metrics.onDutyPeople.date;
  const shifts = asRecord(details?.shifts);
  const isDailyShifts = details?.scope === 'daily_shifts' && shifts !== null;

  if (isDailyShifts) {
    const white = asRecord(shifts.white);
    const night = asRecord(shifts.night);
    const whiteShiftTotal =
      finiteNumber(details.whiteShiftTotal) ??
      finiteNumber(white?.total) ??
      finiteNumber(details.total) ??
      metricTotal;
    const nightShiftTotal =
      finiteNumber(details.nightShiftTotal) ?? finiteNumber(night?.total) ?? 0;

    const orderedShifts = orderShifts(
      [
        {
          shift: 'white' as const,
          shiftLabel:
            typeof white?.shiftLabel === 'string' ? white.shiftLabel : '白班',
          total: whiteShiftTotal,
          dataAvailable: true,
          buildings: normalizeBuildings(white?.buildings ?? details.buildings),
        },
        {
          shift: 'night' as const,
          shiftLabel:
            typeof night?.shiftLabel === 'string' ? night.shiftLabel : '夜班',
          total: nightShiftTotal,
          dataAvailable: true,
          buildings: normalizeBuildings(night?.buildings),
        },
      ],
      onDutyLeadShift,
    );

    return {
      total: orderedShifts[0]?.total ?? whiteShiftTotal,
      whiteShiftTotal,
      nightShiftTotal,
      date,
      isSummaryOnly: false,
      shifts: orderedShifts,
    };
  }

  const legacyTotal = finiteNumber(details?.total) ?? metricTotal;
  const legacyShifts = orderShifts(
    [
      {
        shift: 'white' as const,
        shiftLabel: '白班',
        total: legacyTotal,
        dataAvailable: details !== null,
        buildings: normalizeBuildings(details?.buildings),
      },
      {
        shift: 'night' as const,
        shiftLabel: '夜班',
        total: null,
        dataAvailable: false,
        buildings: [],
      },
    ],
    onDutyLeadShift,
  );
  return {
    total: legacyTotal,
    whiteShiftTotal: legacyTotal,
    nightShiftTotal: null,
    date,
    isSummaryOnly: details === null,
    shifts: legacyShifts,
  };
}

export function buildTopKpiPlaceholders(
  state: 'loading' | 'error',
): PanoramaKpi[] {
  return PANORAMA_KPIS.map((template) => ({
    ...template,
    value: '--',
    comparison: state === 'loading' ? '正在读取' : '数据暂不可用',
    direction: 'neutral',
  }));
}
