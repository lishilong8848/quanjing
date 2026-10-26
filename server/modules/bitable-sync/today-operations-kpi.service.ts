import { HttpService } from '@nestjs/axios';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  TodayOperationsKpiBuilding,
  TodayOperationsKpiBuildingMetricDetails,
  TodayOperationsKpiMetric,
  TodayOperationsOnDutyBuilding,
  TodayOperationsOnDutyPerson,
  TodayOperationsOnDutyPeopleDetails,
  TodayOperationsOnDutyPersonStatus,
  TodayOperationsOnDutyShift,
  TodayOperationsOnDutyShiftDetails,
  TodayOperationsKpiResponse,
} from '../../../shared/today-operations-kpi.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  type BitableRecordSearchFilter,
  type BitableRecordSearchSort,
  type FeishuBitableAuthConfig,
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractDisplayValues,
  extractNumberValue,
  fetchBitableRecords,
  normalizeBuildingForFrontend,
  normalizeBuildingLabel,
  normalizeShiftForFrontend,
  normalizeTeamForFrontend,
  pickField,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  enrichScheduleRecordsWithLeaveApproval,
  fetchLeaveApprovalSnapshot,
} from '../../common/feishu/leave-approval-source';
import {
  buildLongWhiteDutyStaffByBuilding,
  hasMissingLongWhiteDutyBuildings,
  preferMoreCompleteLongWhiteDutyRows,
  type LongWhiteDutyStaffSourceRow,
} from '../duty-schedule/long-white-duty-staff';
import { resolveApprovalAwareDutyStaffFromFields } from '../duty-schedule/approved-leave-visibility';

const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const APPROVAL_VISIBILITY_CACHE_TTL_MS = 30 * 1000;
const APPROVAL_VISIBILITY_CACHE_VERSION = 1;
const STALE_RETRY_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const REQUIRED_BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'] as const;
type RequiredBuilding = (typeof REQUIRED_BUILDINGS)[number];
const PUE_BUILDINGS: readonly RequiredBuilding[] = ['A楼', 'B楼', 'C楼'];
const DUTY_BUILDING_ORDER = [
  'building_h',
  'building_a',
  'building_b',
  'building_c',
  'building_d',
  'building_e',
  'station_110',
] as const;
const EXPECTED_DUTY_BUILDINGS = DUTY_BUILDING_ORDER.filter(
  (building) => building !== 'station_110',
);

const DEFAULT_SOURCE_URLS = {
  safety:
    'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
  personnel:
    'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
  pue: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  itLoad:
    'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  electricity:
    'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
  water:
    'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
} as const;

const SOURCE_DEFINITIONS = {
  safety: {
    envKey: 'TODAY_OPERATIONS_KPI_SAFETY_URL',
    tableName: '今日全景安全运行天数',
    fieldNames: ['起始日期', '安全运行天数'] as const,
  },
  personnel: {
    envKey: 'TODAY_OPERATIONS_KPI_PERSONNEL_URL',
    tableName: '今日全景在岗人数',
    fieldNames: undefined,
  },
  pue: {
    envKey: 'TODAY_OPERATIONS_KPI_PUE_URL',
    tableName: '机楼每日用电汇总',
    fieldNames: ['日期', '楼栋', '汇总分类', 'PUE'] as const,
  },
  itLoad: {
    envKey: 'TODAY_OPERATIONS_KPI_IT_LOAD_URL',
    tableName: '今日全景IT负载率',
    fieldNames: ['日期', '楼栋', '园区IT负载率', 'IT负载率'] as const,
  },
  electricity: {
    envKey: 'TODAY_OPERATIONS_KPI_ELECTRICITY_URL',
    tableName: '今日全景用电量',
    fieldNames: ['日期', '楼栋', '项目', '用电量'] as const,
  },
  water: {
    envKey: 'TODAY_OPERATIONS_KPI_WATER_URL',
    tableName: '今日全景耗水量',
    fieldNames: [
      '执行日期',
      '楼栋',
      '类型',
      '频次',
      '当日耗水总量（实际）',
    ] as const,
  },
} as const;

type SourceKey = keyof typeof DEFAULT_SOURCE_URLS;

interface SourceConfig {
  appToken: string;
  tableId: string;
  tableName: string;
  viewId?: string;
  fieldNames?: readonly string[];
}

interface SourceReadState {
  businessDate: string;
  forceRefresh: boolean;
  stale: boolean;
  staleFetchedAt: number[];
}

interface SourceRecordsOptions {
  config: SourceConfig;
  state: SourceReadState;
  filter?: BitableRecordSearchFilter;
  sort?: readonly BitableRecordSearchSort[];
}

interface CompleteBuildingPeriod {
  date: string;
  records: Map<RequiredBuilding, BitableRecordItem>;
}

interface OnDutyShiftSourceRow extends LongWhiteDutyStaffSourceRow {
  shift: TodayOperationsOnDutyShift;
  timeOffStaff: string[];
}

@Injectable()
export class TodayOperationsKpiService {
  private snapshot:
    | {
        businessDate: string;
        approvalVisibilityVersion: number;
        expiresAt: number;
        retryAt: number;
        response: TodayOperationsKpiResponse;
      }
    | undefined;

  constructor(
    @Inject(HttpService)
    private readonly httpService: HttpService,
  ) {}

  async getKpis(forceRefresh = false): Promise<TodayOperationsKpiResponse> {
    const now = Date.now();
    const businessDate = formatShanghaiDate(now);
    if (
      !forceRefresh &&
      this.snapshot &&
      this.snapshot.businessDate === businessDate &&
      this.snapshot.approvalVisibilityVersion ===
        APPROVAL_VISIBILITY_CACHE_VERSION &&
      hasUsableOnDutyPeopleDetails(this.snapshot.response) &&
      (this.snapshot.expiresAt > now || this.snapshot.retryAt > now)
    ) {
      return this.snapshot.response;
    }

    try {
      const response = await this.loadKpis(new Date(now), forceRefresh);
      this.snapshot = {
        businessDate,
        approvalVisibilityVersion: APPROVAL_VISIBILITY_CACHE_VERSION,
        expiresAt: now + APPROVAL_VISIBILITY_CACHE_TTL_MS,
        retryAt: 0,
        response,
      };
      return response;
    } catch {
      if (
        this.snapshot?.businessDate === businessDate &&
        this.snapshot.approvalVisibilityVersion ===
          APPROVAL_VISIBILITY_CACHE_VERSION
      ) {
        const staleResponse: TodayOperationsKpiResponse = {
          ...withSafeOnDutyPeopleDetails(this.snapshot.response, businessDate),
          sourceStatus: 'stale',
        };
        this.snapshot = {
          businessDate,
          approvalVisibilityVersion: APPROVAL_VISIBILITY_CACHE_VERSION,
          expiresAt: 0,
          retryAt: now + STALE_RETRY_MS,
          response: staleResponse,
        };
        return staleResponse;
      }
      throw new ServiceUnavailableException(
        '今日全景顶部指标暂时不可用，请稍后重试。',
      );
    }
  }

  /** Runs an uncached source read so anomaly detection can retain the exact failing source. */
  async getKpisForAnomalyScan(
    businessDate?: string,
  ): Promise<TodayOperationsKpiResponse> {
    const scanTime = businessDate
      ? new Date(`${businessDate}T12:00:00+08:00`)
      : new Date();
    if (
      Number.isNaN(scanTime.getTime()) ||
      (businessDate && formatShanghaiDate(scanTime.getTime()) !== businessDate)
    ) {
      throw new TypeError(`无效巡视日期：${businessDate}`);
    }
    return this.loadKpis(scanTime, true, 4);
  }

  private async loadKpis(
    now: Date,
    forceRefresh: boolean,
    historyLimit = 3,
  ): Promise<TodayOperationsKpiResponse> {
    const today = formatShanghaiDate(now.getTime());
    const state: SourceReadState = {
      businessDate: today,
      forceRefresh,
      stale: false,
      staleFetchedAt: [],
    };
    const sources = await this.resolveSources();
    const recentDateConditions = buildRecentDateConditions(now);
    const [
      safety,
      personnel,
      pue,
      itLoad,
      electricity,
      water,
      leaveApprovalSnapshot,
    ] = await Promise.all([
      this.readSourceRecords({ config: sources.safety, state }),
      this.readSourceRecords({ config: sources.personnel, state }),
      this.readSourceRecords({
        config: sources.pue,
        state,
        filter: {
          conjunction: 'and',
          conditions: [
            ...recentDateConditions('日期'),
            {
              field_name: '汇总分类',
              operator: 'is',
              value: ['PUE'],
            },
          ],
        },
        sort: [{ field_name: '日期', desc: true }],
      }),
      this.readSourceRecords({
        config: sources.itLoad,
        state,
        filter: {
          conjunction: 'and',
          conditions: recentDateConditions('日期'),
        },
        sort: [{ field_name: '日期', desc: true }],
      }),
      this.readSourceRecords({
        config: sources.electricity,
        state,
        filter: {
          conjunction: 'and',
          conditions: [
            ...recentDateConditions('日期'),
            {
              field_name: '项目',
              operator: 'is',
              value: ['变压器总进线'],
            },
          ],
        },
        sort: [{ field_name: '日期', desc: true }],
      }),
      this.readSourceRecords({
        config: sources.water,
        state,
        filter: {
          conjunction: 'and',
          conditions: [
            ...recentDateConditions('执行日期'),
            {
              field_name: '类型',
              operator: 'is',
              value: ['水耗'],
            },
            {
              field_name: '频次',
              operator: 'is',
              value: ['日'],
            },
          ],
        },
        sort: [{ field_name: '执行日期', desc: true }],
      }),
      fetchLeaveApprovalSnapshot(this.httpService, { forceRefresh }),
    ]);

    let personnelRows = mapOnDutyPeopleRows(
      enrichScheduleRecordsWithLeaveApproval(personnel, leaveApprovalSnapshot),
      today,
    );
    let whiteShiftRows = personnelRows.filter((row) => row.shift === 'white');
    let nightShiftRows = personnelRows.filter((row) => row.shift === 'night');
    if (
      sources.personnel.viewId &&
      (hasMissingLongWhiteDutyBuildings(whiteShiftRows, [
        ...EXPECTED_DUTY_BUILDINGS,
      ]) ||
        hasMissingLongWhiteDutyBuildings(nightShiftRows, [
          ...EXPECTED_DUTY_BUILDINGS,
        ]))
    ) {
      const allTableRecords = await this.readSourceRecords({
        config: {
          ...sources.personnel,
          viewId: undefined,
        },
        state,
      });
      personnelRows = mapOnDutyPeopleRows(
        enrichScheduleRecordsWithLeaveApproval(
          allTableRecords,
          leaveApprovalSnapshot,
        ),
        today,
      );
      whiteShiftRows = preferMoreCompleteLongWhiteDutyRows(
        whiteShiftRows,
        personnelRows.filter((row) => row.shift === 'white'),
        [...EXPECTED_DUTY_BUILDINGS],
      ) as OnDutyShiftSourceRow[];
      nightShiftRows = preferMoreCompleteLongWhiteDutyRows(
        nightShiftRows,
        personnelRows.filter((row) => row.shift === 'night'),
        [...EXPECTED_DUTY_BUILDINGS],
      ) as OnDutyShiftSourceRow[];
    }
    const onDutyPeopleDetails = mapOnDutyPeopleDetails(
      whiteShiftRows,
      nightShiftRows,
      today,
    );
    return {
      sourceStatus: state.stale ? 'stale' : 'fresh',
      syncedAt:
        state.stale && state.staleFetchedAt.length > 0
          ? new Date(Math.min(...state.staleFetchedAt)).toISOString()
          : now.toISOString(),
      metrics: {
        safeOperationDays: mapSafetyMetric(safety, today),
        onDutyPeople: mapOnDutyPeopleMetric(onDutyPeopleDetails),
        averagePue: mapAverageMetric(pue, '日期', 'PUE', 3, PUE_BUILDINGS),
        itLoadRate: mapItLoadMetric(itLoad),
        electricityKwh: mapSumMetric(electricity, '日期', '用电量', 0),
        waterTons: mapSumMetric(water, '执行日期', '当日耗水总量（实际）', 1),
      },
      details: {
        onDutyPeople: onDutyPeopleDetails,
        buildingMetrics: {
          averagePue: mapBuildingMetricDetails(
            pue,
            '日期',
            'PUE',
            3,
            PUE_BUILDINGS,
            PUE_BUILDINGS,
            historyLimit,
          ),
          electricityKwh: mapBuildingMetricDetails(
            electricity,
            '日期',
            '用电量',
            0,
            REQUIRED_BUILDINGS,
            REQUIRED_BUILDINGS,
            historyLimit,
          ),
          waterTons: mapBuildingMetricDetails(
            water,
            '执行日期',
            '当日耗水总量（实际）',
            1,
            REQUIRED_BUILDINGS,
            REQUIRED_BUILDINGS,
            historyLimit,
          ),
        },
      },
    };
  }

  private async resolveSources(): Promise<Record<SourceKey, SourceConfig>> {
    const auth = resolveTodayOperationsKpiAuth();
    const entries = await Promise.all(
      (Object.keys(DEFAULT_SOURCE_URLS) as SourceKey[]).map(async (key) => {
        const definition = SOURCE_DEFINITIONS[key];
        const parsed = parseFeishuBitableLink(
          key === 'personnel'
            ? DEFAULT_SOURCE_URLS.personnel
            : readEnv(definition.envKey) || DEFAULT_SOURCE_URLS[key],
        );
        const appToken = await resolveBitableAppToken(this.httpService, {
          appToken: parsed.appToken,
          wikiToken: parsed.wikiToken,
          tableName: definition.tableName,
          auth,
        });
        if (!appToken || !parsed.tableId) {
          throw new Error(`${definition.tableName}数据源配置不完整`);
        }
        return [
          key,
          {
            appToken,
            tableId: parsed.tableId,
            tableName: definition.tableName,
            viewId: parsed.viewId || undefined,
            fieldNames: definition.fieldNames,
          },
        ] as const;
      }),
    );
    const resolved = new Map<SourceKey, SourceConfig>(entries);
    const requireSource = (key: SourceKey): SourceConfig => {
      const source = resolved.get(key);
      if (!source) throw new Error(`${key}数据源解析失败`);
      return source;
    };
    return {
      safety: requireSource('safety'),
      personnel: requireSource('personnel'),
      pue: requireSource('pue'),
      itLoad: requireSource('itLoad'),
      electricity: requireSource('electricity'),
      water: requireSource('water'),
    };
  }

  private async readSourceRecords(
    options: SourceRecordsOptions,
  ): Promise<BitableRecordItem[]> {
    const auth = resolveTodayOperationsKpiAuth();
    const readOptions = {
      appToken: options.config.appToken,
      tableId: options.config.tableId,
      viewId: options.config.viewId,
      fieldNames: options.config.fieldNames,
      filter: options.filter,
      sort: options.sort,
      tableName: options.config.tableName,
      cacheTtlMs: SOURCE_CACHE_TTL_MS,
      forceRefresh: options.state.forceRefresh,
      strict: true,
      auth,
    } as const;

    try {
      return await fetchBitableRecords(this.httpService, readOptions);
    } catch (error) {
      const persisted = await readLatestPersistedBitableRecordSnapshot({
        tableId: readOptions.tableId,
        tableName: readOptions.tableName,
        viewId: readOptions.viewId,
        fieldNames: readOptions.fieldNames,
        filter: readOptions.filter,
        sort: readOptions.sort,
      });
      if (!persisted) throw error;
      if (
        formatShanghaiDate(persisted.fetchedAt) !== options.state.businessDate
      ) {
        throw error;
      }
      options.state.stale = true;
      options.state.staleFetchedAt.push(persisted.fetchedAt);
      return persisted.records;
    }
  }
}

function hasUsableOnDutyPeopleDetails(
  response: TodayOperationsKpiResponse,
): boolean {
  const details = (
    response as unknown as {
      details?: { onDutyPeople?: Record<string, unknown> };
    }
  ).details?.onDutyPeople;
  const shifts = isRecord(details?.shifts) ? details.shifts : undefined;
  const white = isRecord(shifts?.white) ? shifts.white : undefined;
  const night = isRecord(shifts?.night) ? shifts.night : undefined;
  return Boolean(
    details &&
    details.scope === 'daily_shifts' &&
    typeof details.date === 'string' &&
    Array.isArray(details.buildings) &&
    Number.isFinite(details.total) &&
    Number.isFinite(details.whiteShiftTotal) &&
    Number.isFinite(details.nightShiftTotal) &&
    white &&
    Array.isArray(white.buildings) &&
    night &&
    Array.isArray(night.buildings),
  );
}

function withSafeOnDutyPeopleDetails(
  response: TodayOperationsKpiResponse,
  businessDate: string,
): TodayOperationsKpiResponse {
  if (hasUsableOnDutyPeopleDetails(response)) {
    return response;
  }
  const legacyDetails = (
    response as unknown as {
      details?: {
        onDutyPeople?: {
          date?: unknown;
          total?: unknown;
          buildings?: unknown;
        };
      };
    }
  ).details?.onDutyPeople;
  const metric = response.metrics.onDutyPeople;
  const date =
    typeof legacyDetails?.date === 'string'
      ? legacyDetails.date
      : metric.date || businessDate;
  const buildings = normalizeLegacyOnDutyBuildings(legacyDetails?.buildings);
  const whiteShiftTotal = Number.isFinite(legacyDetails?.total)
    ? Number(legacyDetails?.total)
    : Number.isFinite(metric.value)
      ? metric.value
      : 0;
  return {
    ...response,
    details: {
      ...response.details,
      onDutyPeople: {
        scope: 'daily_shifts',
        date,
        buildings,
        total: whiteShiftTotal,
        whiteShiftTotal,
        nightShiftTotal: 0,
        shifts: {
          white: {
            shift: 'white',
            shiftLabel: '白班',
            total: whiteShiftTotal,
            buildings,
          },
          night: {
            shift: 'night',
            shiftLabel: '夜班',
            total: 0,
            buildings: [],
          },
        },
      },
    },
  };
}

function normalizeLegacyOnDutyBuildings(
  value: unknown,
): TodayOperationsOnDutyBuilding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const building = typeof item.building === 'string' ? item.building : '';
    if (!building) return [];
    const buildingName =
      typeof item.buildingName === 'string' ? item.buildingName : building;
    const staff = dedupeNames(
      Array.isArray(item.staff)
        ? item.staff.filter((name): name is string => typeof name === 'string')
        : [],
    );
    return [
      {
        building,
        buildingName,
        staff,
        people: staff.map((name) =>
          createOnDutyPerson(name, 'on_duty', true, []),
        ),
      },
    ];
  });
}

function mapSafetyMetric(
  records: BitableRecordItem[],
  today: string,
): TodayOperationsKpiMetric {
  const value = records
    .map((item) => extractNumberValue(item.fields?.['安全运行天数']))
    .find((item): item is number => item !== null);
  if (value === undefined) {
    throw new Error('安全运行天数缺少有效数值');
  }
  return {
    value: round(value, 0),
    previousValue: null,
    date: today,
  };
}

function mapOnDutyPeopleMetric(
  details: TodayOperationsOnDutyPeopleDetails,
): TodayOperationsKpiMetric {
  return {
    value: details.whiteShiftTotal,
    previousValue: null,
    date: details.date,
  };
}

function mapOnDutyPeopleDetails(
  whiteShiftRows: OnDutyShiftSourceRow[],
  nightShiftRows: OnDutyShiftSourceRow[],
  today: string,
): TodayOperationsOnDutyPeopleDetails {
  const whiteActiveStaff = new Set<string>();
  const whiteActiveBuildings = buildActiveDutyBuildings(
    whiteShiftRows,
    whiteActiveStaff,
  );
  const nightActiveStaff = new Set<string>();
  const nightActiveBuildings = buildActiveDutyBuildings(
    nightShiftRows,
    nightActiveStaff,
  );
  const white = buildShiftDetails(
    'white',
    whiteShiftRows,
    whiteActiveBuildings,
    whiteActiveStaff,
    new Set(whiteActiveStaff),
  );
  const night = buildShiftDetails(
    'night',
    nightShiftRows,
    nightActiveBuildings,
    nightActiveStaff,
    new Set(nightActiveStaff),
  );

  return {
    scope: 'daily_shifts',
    date: today,
    buildings: white.buildings,
    total: white.total,
    whiteShiftTotal: white.total,
    nightShiftTotal: night.total,
    shifts: { white, night },
  };
}

interface ActiveDutyBuilding {
  building: string;
  buildingName: string;
  staff: string[];
}

function buildActiveDutyBuildings(
  rows: OnDutyShiftSourceRow[],
  seenStaff: Set<string>,
): ActiveDutyBuilding[] {
  return buildLongWhiteDutyStaffByBuilding(
    rows.map((row) => ({
      ...row,
      leaveStaff: dedupeNames([...row.leaveStaff, ...row.timeOffStaff]),
    })),
    [...DUTY_BUILDING_ORDER],
  )
    .map((building) => ({
      ...building,
      staff: building.staff.filter((name) => {
        const key = normalizeStaffKey(name);
        if (!key || seenStaff.has(key)) {
          return false;
        }
        seenStaff.add(key);
        return true;
      }),
    }))
    .filter((building) => building.staff.length > 0);
}

function buildShiftDetails(
  shift: TodayOperationsOnDutyShift,
  rows: OnDutyShiftSourceRow[],
  activeBuildings: ActiveDutyBuilding[],
  activeStaff: Set<string>,
  seenInactiveStaff: Set<string>,
): TodayOperationsOnDutyShiftDetails {
  const rowsByBuilding = new Map<string, OnDutyShiftSourceRow[]>();
  rows.forEach((row) => {
    const group = rowsByBuilding.get(row.building) ?? [];
    group.push(row);
    rowsByBuilding.set(row.building, group);
  });
  const activeByBuilding = new Map(
    activeBuildings.map((building) => [building.building, building]),
  );
  const buildingKeys = dedupeNames([
    ...DUTY_BUILDING_ORDER,
    ...rowsByBuilding.keys(),
    ...activeByBuilding.keys(),
  ]).filter(
    (building) =>
      rowsByBuilding.has(building) || activeByBuilding.has(building),
  );
  const buildings = buildingKeys.flatMap((building) => {
    const buildingRows = rowsByBuilding.get(building) ?? [];
    const activeBuilding = activeByBuilding.get(building);
    const staff = activeBuilding?.staff ?? [];
    const people = [
      ...staff.map((name) => buildActivePerson(name, buildingRows)),
      ...buildInactivePeople(buildingRows, activeStaff, seenInactiveStaff),
    ];
    if (staff.length === 0 && people.length === 0) return [];
    return [
      {
        building,
        buildingName:
          activeBuilding?.buildingName ||
          buildingRows[0]?.buildingName ||
          building,
        staff,
        people,
      },
    ];
  });
  return {
    shift,
    shiftLabel: shift === 'white' ? '白班' : '夜班',
    total: buildings.reduce(
      (total, building) => total + building.staff.length,
      0,
    ),
    buildings,
  };
}

function buildActivePerson(
  name: string,
  rows: OnDutyShiftSourceRow[],
): TodayOperationsOnDutyPerson {
  const key = normalizeStaffKey(name);
  const vacancyRows = rows.filter((row) =>
    includesStaff(row.vacancySubstituteStaff ?? [], key),
  );
  if (vacancyRows.length > 0) {
    return createOnDutyPerson(name, 'vacancy_substitute', true, []);
  }
  const substituteRows = rows.filter((row) =>
    includesStaff(row.substituteStaff, key),
  );
  if (substituteRows.length > 0) {
    return createOnDutyPerson(
      name,
      'substitute',
      true,
      getAbsentStaff(substituteRows),
    );
  }
  return createOnDutyPerson(name, 'on_duty', true, []);
}

function buildInactivePeople(
  rows: OnDutyShiftSourceRow[],
  activeStaff: Set<string>,
  seenInactiveStaff: Set<string>,
): TodayOperationsOnDutyPerson[] {
  const definitions: Array<{
    status: TodayOperationsOnDutyPersonStatus;
    read: (row: OnDutyShiftSourceRow) => string[];
  }> = [
    { status: 'time_off', read: (row) => row.timeOffStaff },
    { status: 'leave', read: (row) => row.leaveStaff },
    { status: 'travel', read: (row) => row.travelStaff ?? [] },
  ];
  const people: TodayOperationsOnDutyPerson[] = [];
  definitions.forEach(({ status, read }) => {
    dedupeNames(rows.flatMap(read)).forEach((name) => {
      const key = normalizeStaffKey(name);
      if (!key || activeStaff.has(key) || seenInactiveStaff.has(key)) return;
      const matchingRows = rows.filter((row) => includesStaff(read(row), key));
      const relatedStaff =
        status === 'travel'
          ? []
          : dedupeNames(matchingRows.flatMap((row) => row.substituteStaff));
      seenInactiveStaff.add(key);
      people.push(createOnDutyPerson(name, status, false, relatedStaff));
    });
  });
  return people;
}

function getAbsentStaff(rows: OnDutyShiftSourceRow[]): string[] {
  return dedupeNames(
    rows.flatMap((row) => [...row.leaveStaff, ...row.timeOffStaff]),
  );
}

function includesStaff(staff: string[], normalizedName: string): boolean {
  return staff.some((name) => normalizeStaffKey(name) === normalizedName);
}

const ON_DUTY_STATUS_LABELS: Record<TodayOperationsOnDutyPersonStatus, string> =
  {
    on_duty: '在岗',
    leave: '请假',
    time_off: '调休',
    substitute: '替班',
    vacancy_substitute: '补位',
    travel: '差旅',
  };

function createOnDutyPerson(
  name: string,
  status: TodayOperationsOnDutyPersonStatus,
  onDuty: boolean,
  relatedStaff: string[],
): TodayOperationsOnDutyPerson {
  return {
    name,
    status,
    statusLabel: ON_DUTY_STATUS_LABELS[status],
    onDuty,
    relatedStaff: dedupeNames(relatedStaff),
  };
}

function mapOnDutyPeopleRows(
  records: BitableRecordItem[],
  today: string,
): OnDutyShiftSourceRow[] {
  const rows: OnDutyShiftSourceRow[] = [];

  records.forEach((record) => {
    const fields = record.fields ?? {};
    const scheduleDate = extractDateValue(
      pickField(fields, [
        'fldZSaDbGf',
        '排班日期',
        '日期',
        'schedule_date',
        '排班日期（日期）',
      ]),
    );
    if (scheduleDate !== today) {
      return;
    }

    const team = normalizeTeamForFrontend(
      extractDisplayText(pickField(fields, ['fldE9Gwnk7', '班组', '班别'])),
    );
    const shift = normalizeShiftForFrontend(
      extractDisplayText(pickField(fields, ['fldqPpOgW5', '班次', '值班班次'])),
    );
    const dutyShift = normalizeOnDutyShift(shift, team);
    if (!dutyShift) {
      return;
    }

    const buildingText = extractDisplayText(
      pickField(fields, [
        'fldnP4gXMn',
        'fldUHstSKX',
        '机楼',
        '楼栋',
        '值守机楼',
      ]),
    );
    const building = normalizeBuildingForFrontend(buildingText);
    if (!building) {
      return;
    }

    const approvedLeave = resolveApprovalAwareDutyStaffFromFields(fields);
    const staff = approvedLeave.dutyStaff;
    const leaveStaff = approvedLeave.leaveStaff;
    const timeOffStaff = extractStaffNames(
      pickField(fields, [
        '调休人员',
        '调休',
        '休息人员',
        '轮休人员',
        '补休人员',
      ]),
    );
    const substituteStaff = approvedLeave.substituteStaff;
    const vacancySubstituteStaff = extractStaffNames(
      pickField(fields, [
        '缺岗替班',
        '缺岗替班人员',
        '缺岗替代',
        '缺岗人员替班',
      ]),
    );
    const travelStaff = extractStaffNames(
      pickField(fields, ['差旅人员', '出差人员', '差旅', '差旅人员信息']),
    );

    if (
      staff.length === 0 &&
      leaveStaff.length === 0 &&
      timeOffStaff.length === 0 &&
      substituteStaff.length === 0 &&
      vacancySubstituteStaff.length === 0 &&
      travelStaff.length === 0
    ) {
      return;
    }

    rows.push({
      shift: dutyShift,
      building,
      buildingName: normalizeBuildingLabel(buildingText),
      staff,
      leaveStaff,
      timeOffStaff,
      substituteStaff,
      vacancySubstituteStaff,
      travelStaff,
    });
  });
  return rows;
}

function normalizeOnDutyShift(
  shift: string,
  team: string,
): TodayOperationsOnDutyShift | null {
  if (shift === 'night') return 'night';
  if (
    shift === 'white' ||
    shift === 'long_white' ||
    (!shift && team === 'long_white')
  ) {
    return 'white';
  }
  return null;
}

function extractStaffNames(field: unknown): string[] {
  return dedupeNames(
    extractDisplayValues(field)
      .flatMap((value) => value.split(/[\s、,，;；/]+/))
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function normalizeStaffKey(value: string): string {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase();
}

function dedupeNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeStaffKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mapAverageMetric(
  records: BitableRecordItem[],
  dateField: string,
  valueField: string,
  precision: number,
  requiredBuildings: readonly RequiredBuilding[] = REQUIRED_BUILDINGS,
): TodayOperationsKpiMetric {
  const [current, previous] = getLatestCompletePeriods(
    records,
    dateField,
    requiredBuildings,
    valueField,
  );
  return {
    value: round(
      averagePeriod(current, valueField, requiredBuildings),
      precision,
    ),
    previousValue: previous
      ? round(averagePeriod(previous, valueField, requiredBuildings), precision)
      : null,
    date: current.date,
  };
}

function mapBuildingMetricDetails(
  records: BitableRecordItem[],
  dateField: string,
  valueField: string,
  precision: number,
  completeBuildings: readonly RequiredBuilding[] = REQUIRED_BUILDINGS,
  includedBuildings: readonly RequiredBuilding[] = REQUIRED_BUILDINGS,
  historyLimit = 3,
): TodayOperationsKpiBuildingMetricDetails {
  const periods = getCompletePeriods(
    records,
    dateField,
    completeBuildings,
    valueField,
  );
  const [current, previous] = periods;
  return {
    date: current.date,
    previousDate: previous?.date ?? null,
    includedBuildings: [...includedBuildings] as TodayOperationsKpiBuilding[],
    rows: REQUIRED_BUILDINGS.map((building) => ({
      building,
      value: readPeriodBuildingValue(current, building, valueField, precision),
      previousValue: previous
        ? readPeriodBuildingValue(previous, building, valueField, precision)
        : null,
    })),
    history: periods.slice(0, historyLimit).map((period) => ({
      date: period.date,
      rows: includedBuildings.map((building) => ({
        building,
        value: readRequiredPeriodBuildingValue(
          period,
          building,
          valueField,
          precision,
        ),
      })),
    })),
  };
}

function readPeriodBuildingValue(
  period: CompleteBuildingPeriod,
  building: RequiredBuilding,
  fieldName: string,
  precision: number,
): number | null {
  const value = extractNumberValue(
    period.records.get(building)?.fields?.[fieldName],
  );
  return value === null ? null : round(value, precision);
}

function readRequiredPeriodBuildingValue(
  period: CompleteBuildingPeriod,
  building: RequiredBuilding,
  fieldName: string,
  precision: number,
): number {
  const value = readPeriodBuildingValue(
    period,
    building,
    fieldName,
    precision,
  );
  if (value === null) {
    throw new Error(`${period.date}${building}缺少${fieldName}`);
  }
  return value;
}

function mapItLoadMetric(
  records: BitableRecordItem[],
): TodayOperationsKpiMetric {
  const [current, previous] = getLatestCompletePeriods(records, '日期');
  return {
    value: round(readItLoadPercent(current), 1),
    previousValue: previous ? round(readItLoadPercent(previous), 1) : null,
    date: current.date,
  };
}

function mapSumMetric(
  records: BitableRecordItem[],
  dateField: string,
  valueField: string,
  precision: number,
): TodayOperationsKpiMetric {
  const [current, previous] = getLatestCompletePeriods(
    records,
    dateField,
    REQUIRED_BUILDINGS,
    valueField,
  );
  return {
    value: round(sumPeriod(current, valueField), precision),
    previousValue: previous
      ? round(sumPeriod(previous, valueField), precision)
      : null,
    date: current.date,
  };
}

function getLatestCompletePeriods(
  records: BitableRecordItem[],
  dateField: string,
  requiredBuildings: readonly RequiredBuilding[] = REQUIRED_BUILDINGS,
  requiredValueField?: string,
): [CompleteBuildingPeriod, CompleteBuildingPeriod | undefined] {
  const complete = getCompletePeriods(
    records,
    dateField,
    requiredBuildings,
    requiredValueField,
  );
  return [complete[0], complete[1]];
}

function getCompletePeriods(
  records: BitableRecordItem[],
  dateField: string,
  requiredBuildings: readonly RequiredBuilding[] = REQUIRED_BUILDINGS,
  requiredValueField?: string,
): CompleteBuildingPeriod[] {
  const periods = new Map<string, Map<RequiredBuilding, BitableRecordItem>>();
  for (const item of records) {
    const date = extractBusinessDate(item.fields?.[dateField]);
    const building = normalizeRequiredBuilding(item.fields?.['楼栋']);
    if (!date || !building) continue;
    const buildingRecords = periods.get(date) ?? new Map();
    const existing = buildingRecords.get(building);
    if (
      !existing ||
      Number(item.last_modified_time ?? 0) >=
        Number(existing.last_modified_time ?? 0)
    ) {
      buildingRecords.set(building, item);
    }
    periods.set(date, buildingRecords);
  }

  const complete = [...periods.entries()]
    .filter(([, items]) =>
      requiredBuildings.every((building) => {
        const item = items.get(building);
        return (
          Boolean(item) &&
          (!requiredValueField ||
            extractNumberValue(item?.fields?.[requiredValueField]) !== null)
        );
      }),
    )
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, items]) => ({ date, records: items }));
  if (!complete[0]) {
    throw new Error(
      `${dateField}近31日缺少完整的${requiredBuildings.join('、')}数据`,
    );
  }
  return complete;
}

function averagePeriod(
  period: CompleteBuildingPeriod,
  fieldName: string,
  requiredBuildings: readonly RequiredBuilding[] = REQUIRED_BUILDINGS,
): number {
  return (
    sumPeriod(period, fieldName, requiredBuildings) / requiredBuildings.length
  );
}

function sumPeriod(
  period: CompleteBuildingPeriod,
  fieldName: string,
  requiredBuildings: readonly RequiredBuilding[] = REQUIRED_BUILDINGS,
): number {
  return requiredBuildings.reduce((sum, building) => {
    const value = extractNumberValue(
      period.records.get(building)?.fields?.[fieldName],
    );
    if (value === null) {
      throw new Error(`${period.date}${building}缺少${fieldName}`);
    }
    return sum + value;
  }, 0);
}

function readItLoadPercent(period: CompleteBuildingPeriod): number {
  const parkValues = REQUIRED_BUILDINGS.map((building) =>
    extractNumberValue(period.records.get(building)?.fields?.['园区IT负载率']),
  ).filter((value): value is number => value !== null);
  const raw =
    parkValues.length > 0
      ? parkValues.reduce((sum, value) => sum + value, 0) / parkValues.length
      : averagePeriod(period, 'IT负载率');
  return Math.abs(raw) <= 1 ? raw * 100 : raw;
}

function normalizeRequiredBuilding(
  field: unknown,
): (typeof REQUIRED_BUILDINGS)[number] | null {
  const text = extractDisplayText(field).trim().toUpperCase();
  const match = text.match(/([A-E])(?:楼|栋)?/u)?.[1];
  const building = match ? `${match}楼` : '';
  return REQUIRED_BUILDINGS.includes(
    building as (typeof REQUIRED_BUILDINGS)[number],
  )
    ? (building as (typeof REQUIRED_BUILDINGS)[number])
    : null;
}

function extractBusinessDate(field: unknown): string | null {
  const iso = extractDateTimeIso(field);
  if (iso) return formatShanghaiDate(Date.parse(iso));
  return extractDateValue(field);
}

function buildRecentDateConditions(now: Date) {
  const currentDate = formatShanghaiDate(now.getTime());
  const currentStart = Date.parse(`${currentDate}T00:00:00+08:00`);
  const lowerExclusive = currentStart - 32 * DAY_MS;
  const upperExclusive = currentStart + DAY_MS;
  return (fieldName: string): BitableRecordSearchFilter['conditions'] => [
    {
      field_name: fieldName,
      operator: 'isGreater',
      value: ['ExactDate', String(lowerExclusive)],
    },
    {
      field_name: fieldName,
      operator: 'isLess',
      value: ['ExactDate', String(upperExclusive)],
    },
  ];
}

function resolveTodayOperationsKpiAuth(): FeishuBitableAuthConfig | undefined {
  const candidates = [
    [
      readEnv('TODAY_OPERATIONS_KPI_FEISHU_APP_ID'),
      readEnv('TODAY_OPERATIONS_KPI_FEISHU_APP_SECRET'),
    ],
    [
      readEnv('FEISHU_RISK_INSPECTION_APP_ID'),
      readEnv('FEISHU_RISK_INSPECTION_APP_SECRET'),
    ],
    [
      readEnv('ALI_MONTHLY_REPORT_FEISHU_APP_ID'),
      readEnv('ALI_MONTHLY_REPORT_FEISHU_APP_SECRET'),
    ],
  ];
  for (const [appId, appSecret] of candidates) {
    if (appId && appSecret) return { appId, appSecret };
  }
  return undefined;
}

function formatShanghaiDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
