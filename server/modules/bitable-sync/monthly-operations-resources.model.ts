import { BadRequestException } from '@nestjs/common';
import {
  MONTHLY_RESOURCE_BUILDINGS,
  type MonthlyEnergyPoint,
  type MonthlyRackRow,
  type MonthlyRackMovement,
  type MonthlyTemperaturePoint,
} from '../../../shared/monthly-operations-resources.interface';
import {
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractNumberValue,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import type { MonthlyWaterPoint } from '../../../shared/monthly-operations-resources.interface';

export function shanghaiDay(time: number | Date = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(time);
}
export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000)
    .toISOString()
    .slice(0, 10);
}
function validDay(day: unknown): day is string {
  return (
    typeof day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day
  );
}
export function resourceRange(
  start: unknown,
  end: unknown,
  today = shanghaiDay(),
) {
  if (
    !validDay(start) ||
    !validDay(end) ||
    start > end ||
    start > today ||
    (Date.parse(end) - Date.parse(start)) / 86400000 > 730
  )
    throw new BadRequestException(
      '请选择不超过两年的有效日期范围，开始日期不能晚于今天',
    );
  const asOf = end < today ? end : today;
  const trendStart = addDays(asOf, -29);
  return { start, end, asOf, trendStart };
}
function fieldDate(field: unknown): string | null {
  const iso = extractDateTimeIso(field);
  if (iso) return shanghaiDay(Date.parse(iso));
  const day = extractDateValue(field);
  return validDay(day) ? day : null;
}
function number(field: unknown): number | null {
  const value = extractNumberValue(field);
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}
function energyNumber(calculated: unknown, editable: unknown): number | null {
  const value = number(calculated);
  const fallback = number(editable);
  // The source formula can return zero while the editable metered value is populated.
  return value === 0 && fallback !== null && fallback > 0
    ? fallback
    : (value ?? fallback);
}
function uniqueValue(values: Array<number | null>): number | null {
  const known = [
    ...new Set(values.filter((value): value is number => value !== null)),
  ];
  return known.length === 1 ? known[0] : null;
}
export function mapMonthlyRacks(records: BitableRecordItem[], asOf: string) {
  const valid = records.flatMap((record) => {
    const fields = record.fields ?? {};
    const building = extractDisplayText(fields['楼栋名称']);
    const year = extractDisplayText(fields['年度']);
    const month = extractDisplayText(fields['月度']).padStart(2, '0');
    const date = fieldDate(fields['当月最后日期']);
    const capacity = number(fields['机柜设计数量']);
    const online = number(fields['实际上电数量']);
    if (
      !MONTHLY_RESOURCE_BUILDINGS.includes(
        building as MonthlyRackRow['building'],
      ) ||
      !date ||
      date > asOf ||
      !/^\d{4}$/.test(year) ||
      !/^(0[1-9]|1[0-2])$/.test(month) ||
      date.slice(0, 7) !== `${year}-${month}` ||
      capacity === null ||
      capacity <= 0 ||
      online === null ||
      online > capacity ||
      !Number.isInteger(capacity) ||
      !Number.isInteger(online)
    )
      return [];
    return [
      {
        building: building as MonthlyRackRow['building'],
        month: `${year}-${month}`,
        date,
        capacity,
        online,
        rate: (online / capacity) * 100,
      },
    ];
  });
  const month =
    valid
      .map((row) => row.month)
      .sort()
      .at(-1) ?? null;
  const rows = MONTHLY_RESOURCE_BUILDINGS.flatMap((building) => {
    const matches = valid.filter(
      (row) => row.month === month && row.building === building,
    );
    if (
      !matches.length ||
      new Set(matches.map((row) => JSON.stringify(row))).size !== 1
    )
      return [];
    const { month: _month, ...row } = matches[0];
    return [row];
  });
  return { month, rows };
}
const EMPTY_ENERGY = {
  pue: null,
  total: null,
  it: null,
  nonIt: null,
  cooling: null,
  terminal: null,
  auxiliary: null,
  pueWeight: null,
};
export function mapMonthlyRackHistory(
  records: BitableRecordItem[],
  asOf: string,
) {
  const anchor = new Date(`${asOf.slice(0, 7)}-01T00:00:00Z`);
  return Array.from({ length: 12 }, (_, index) => {
    const first = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 11 + index, 1),
    );
    const month = first.toISOString().slice(0, 7);
    const last = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .slice(0, 10);
    const result = mapMonthlyRacks(records, last > asOf ? asOf : last);
    return { month, rows: result.month === month ? result.rows : [] };
  });
}
export function mapMonthlyRackMovements(
  records: BitableRecordItem[],
  start: string,
  asOf: string,
): MonthlyRackMovement[] {
  const seen = new Set<string>();
  return records
    .flatMap((record) => {
      const fields = record.fields ?? {};
      const id = getRecordId(record);
      const date = fieldDate(fields['日期']);
      const building = extractDisplayText(fields['楼栋']);
      const poweredOn = number(fields['本班组上电机柜数（个）']);
      const poweredOff = number(fields['本班组下电机柜数（个）']);
      if (
        !id ||
        seen.has(id) ||
        !date ||
        date < start ||
        date > asOf ||
        !MONTHLY_RESOURCE_BUILDINGS.includes(
          building as MonthlyRackRow['building'],
        ) ||
        (poweredOn === null && poweredOff === null) ||
        (poweredOn !== null && !Number.isInteger(poweredOn)) ||
        (poweredOff !== null && !Number.isInteger(poweredOff))
      )
        return [];
      seen.add(id);
      return [
        {
          id,
          date,
          building: building as MonthlyRackRow['building'],
          shift: extractDisplayText(fields['班次']) || '未标注',
          poweredOn: poweredOn ?? 0,
          poweredOff: poweredOff ?? 0,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || a.building.localeCompare(b.building),
    );
}
export function mapMonthlyLoad(records: BitableRecordItem[], asOf: string) {
  const groups = new Map<string, Map<string, Record<string, unknown>[]>>();
  for (const record of records) {
    const fields = record.fields ?? {},
      date = fieldDate(fields['日期']),
      building = extractDisplayText(fields['楼栋']);
    if (
      !date ||
      date > asOf ||
      !MONTHLY_RESOURCE_BUILDINGS.includes(
        building as MonthlyRackRow['building'],
      )
    )
      continue;
    const group =
      groups.get(date) ?? new Map<string, Record<string, unknown>[]>();
    group.set(building, [...(group.get(building) ?? []), fields]);
    groups.set(date, group);
  }
  const percent = (raw: number) => (raw <= 1 ? raw * 100 : raw);
  for (const [date, group] of [...groups].sort(([a], [b]) =>
    b.localeCompare(a),
  )) {
    const rows = MONTHLY_RESOURCE_BUILDINGS.flatMap((building) => {
      const records = group.get(building) ?? [],
        value = uniqueValue(records.map((row) => number(row['IT负载率'])));
      return value === null ? [] : [{ building, value: percent(value) }];
    });
    if (rows.length !== 5) continue;
    const park = MONTHLY_RESOURCE_BUILDINGS.flatMap((building) => {
      const value = uniqueValue(
        (group.get(building) ?? []).map((row) => number(row['园区IT负载率'])),
      );
      return value === null ? [] : [value];
    });
    return {
      date,
      rows,
      park: park.length
        ? percent(park.reduce((s, v) => s + v, 0) / park.length)
        : rows.reduce((s, r) => s + r.value, 0) / rows.length,
    };
  }
  return { date: null, rows: [], park: null };
}
const ENERGY_CATEGORIES = {
  total: '总用电量',
  it: 'IT用电量',
  cooling: '冷源用电',
  terminal: '末端空调用电',
  auxiliary: '辅助用电',
} as const;
export function mapMonthlyEnergy(
  records: BitableRecordItem[],
  start: string,
  end: string,
): MonthlyEnergyPoint[] {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const record of records) {
    const fields = record.fields ?? {};
    const date = fieldDate(fields['日期']);
    const building = extractDisplayText(fields['楼栋']);
    if (
      !date ||
      date < start ||
      date > end ||
      !MONTHLY_RESOURCE_BUILDINGS.includes(
        building as MonthlyRackRow['building'],
      )
    )
      continue;
    const key = `${date}:${building}`;
    grouped.set(key, [...(grouped.get(key) ?? []), fields]);
  }
  const points: MonthlyEnergyPoint[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const rows = MONTHLY_RESOURCE_BUILDINGS.map((building) => {
      const fields = grouped.get(`${date}:${building}`) ?? [];
      const pueRows = fields.filter(
        (row) => extractDisplayText(row['汇总分类']) === 'PUE',
      );
      const pue = uniqueValue(pueRows.map((row) => number(row['PUE（数值）'])));
      const row: MonthlyEnergyPoint = {
        date,
        building,
        ...EMPTY_ENERGY,
        pue: pue !== null && pue > 0 ? pue : null,
      };
      for (const [metric, category] of Object.entries(ENERGY_CATEGORIES)) {
        row[metric as keyof typeof ENERGY_CATEGORIES] = uniqueValue(
          fields
            .filter((row) => extractDisplayText(row['汇总分类']) === category)
            .map((row) =>
              energyNumber(
                row['数值（3位小数点）'],
                row['数值（3位小数点）-可编辑'],
              ),
            ),
        );
      }
      const nonIt = uniqueValue(
        pueRows.map((row) =>
          energyNumber(row['非IT用电量（万）'], row['非IT用电量（万）-可编辑']),
        ),
      );
      row.nonIt = nonIt === null ? null : nonIt * 10000;
      row.pueWeight =
        row.pue !== null && row.it !== null && row.it > 0 ? row.it : null;
      return row;
    });
    const park: MonthlyEnergyPoint = {
      date,
      building: '园区',
      ...EMPTY_ENERGY,
    };
    const abc = rows.slice(0, 3);
    if (
      abc.every(
        (row) =>
          row.pue !== null && row.pueWeight !== null && row.pueWeight > 0,
      )
    ) {
      park.pueWeight = abc.reduce((sum, row) => sum + row.pueWeight!, 0);
      park.pue =
        abc.reduce((sum, row) => sum + row.pue! * row.pueWeight!, 0) /
        park.pueWeight;
    }
    for (const metric of [
      'total',
      'it',
      'nonIt',
      'cooling',
      'terminal',
      'auxiliary',
    ] as const) {
      if (rows.every((row) => row[metric] !== null))
        park[metric] = rows.reduce((sum, row) => sum + row[metric]!, 0);
    }
    points.push(park, ...rows);
  }
  return points;
}
export function mapMonthlyTemperature(
  records: BitableRecordItem[],
  start: string,
  end: string,
): MonthlyTemperaturePoint[] {
  const shifts = new Map<string, Array<number | null>>();
  for (const record of records) {
    const fields = record.fields ?? {};
    const date = fieldDate(fields['日期']);
    const building = extractDisplayText(fields['楼栋']).trim();
    const shift = extractDisplayText(fields['班次']).trim();
    const value = extractNumberValue(fields['室外湿球温度（℃）']);
    if (
      !date ||
      date < start ||
      date > end ||
      !MONTHLY_RESOURCE_BUILDINGS.includes(
        building as MonthlyRackRow['building'],
      ) ||
      !shift
    )
      continue;
    const key = `${date}:${building}:${shift}`;
    shifts.set(key, [
      ...(shifts.get(key) ?? []),
      value !== null && Number.isFinite(value) ? value : null,
    ]);
  }
  const daily = new Map<string, number[]>();
  for (const [key, samples] of shifts) {
    const value = uniqueValue(samples);
    if (value === null) continue;
    const group = key.split(':').slice(0, 2).join(':');
    const values = daily.get(group) ?? [];
    values.push(value);
    daily.set(group, values);
  }
  const points: MonthlyTemperaturePoint[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const rows = MONTHLY_RESOURCE_BUILDINGS.map((building) => {
      const values = daily.get(`${date}:${building}`) ?? [];
      return {
        date,
        building,
        value: values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null,
        samples: values.length,
      };
    });
    points.push(
      {
        date,
        building: '园区',
        value: rows.every((row) => row.value !== null)
          ? rows.reduce((sum, row) => sum + row.value!, 0) / rows.length
          : null,
        samples: rows.reduce((sum, row) => sum + row.samples, 0),
      },
      ...rows,
    );
  }
  return points;
}
export function mapMonthlyWater(
  records: BitableRecordItem[],
  start: string,
  end: string,
): MonthlyWaterPoint[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const fields = record.fields ?? {};
    const date = fieldDate(fields['执行日期']);
    const building = extractDisplayText(fields['楼栋']);
    if (
      !date ||
      date < start ||
      date > end ||
      !MONTHLY_RESOURCE_BUILDINGS.includes(
        building as MonthlyRackRow['building'],
      ) ||
      extractDisplayText(fields['类型']) !== '水耗' ||
      extractDisplayText(fields['频次']) !== '日'
    )
      continue;
    const key = `${date}:${building}`;
    const rows = groups.get(key) ?? [];
    rows.push(fields);
    groups.set(key, rows);
  }
  const points: MonthlyWaterPoint[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const rows = MONTHLY_RESOURCE_BUILDINGS.map((building) => {
      const records = groups.get(`${date}:${building}`) ?? [];
      const read = (field: string) =>
        uniqueValue(records.map((row) => number(row[field])));
      const wue = read('WUE'),
        weight = read('当日用电量');
      return {
        date,
        building,
        water: read('当日耗水总量'),
        waterEast: read('东区耗水量'),
        waterWest: read('西区耗水量'),
        wue,
        wueWeight:
          wue !== null && weight !== null && weight > 0 ? weight : null,
      };
    });
    const park: MonthlyWaterPoint = {
      date,
      building: '园区',
      water: null,
      waterEast: null,
      waterWest: null,
      wue: null,
      wueWeight: null,
    };
    for (const metric of ['water', 'waterEast', 'waterWest'] as const) {
      if (rows.every((row) => row[metric] !== null))
        park[metric] = rows.reduce((sum, row) => sum + row[metric]!, 0);
    }
    if (rows.every((row) => row.wue !== null && row.wueWeight !== null)) {
      park.wueWeight = rows.reduce((sum, row) => sum + row.wueWeight!, 0);
      park.wue =
        rows.reduce((sum, row) => sum + row.wue! * row.wueWeight!, 0) /
        park.wueWeight;
    }
    points.push(park, ...rows);
  }
  return points;
}
