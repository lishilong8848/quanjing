import { HttpService } from '@nestjs/axios';
import {
  Inject,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  TodayOperationsAlarmBuildingPoint,
  TodayOperationsAlarmChartBuilding,
  TodayOperationsAlarmDashboardQuery,
  TodayOperationsAlarmDashboardResponse,
  TodayOperationsAlarmExpectation,
  TodayOperationsAlarmHandlingStatus,
  TodayOperationsAlarmItem,
  TodayOperationsAlarmTagIssueCode,
  TodayOperationsAlarmWindow,
} from '../../../shared/today-operations-alarm.interface';
import { TODAY_OPERATIONS_ALARM_BUILDINGS } from '../../../shared/today-operations-alarm.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  type BitableRecordSearchFilter,
  type FeishuBitableAuthConfig,
  extractDateTimeIso,
  extractDisplayText,
  fetchBitableRecords,
  getRecordId,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import { AlarmTagSemanticReviewer, getAlarmTagSemanticReviewer } from './today-operations-alarm-tag-ai';
import { detectAlarmTagRuleIssues } from './today-operations-alarm-tag-rules';
import { ALARM_REVIEW_OUTCOMES, type AlarmReviewOutcome } from '../../../shared/today-operations-alarm-review.interface';
import { ALARM_REVIEW_FIELD, ALARM_REVIEW_PERSON_FIELD, ALARM_REVIEW_REPLY_FIELD, readAlarmReviewReply, reviewVersion } from './alarm-review.rules';

const SOURCE_TABLE_NAME = '今日全景告警信息';
export const DEFAULT_ALARM_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_SNAPSHOT_RETRY_MS = 30 * 1000;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const EMPTY_SOURCE_OPTION = '未设置';
const STALE_WARNING =
  '飞书实时告警数据暂时不可用，当前展示最近一次成功同步的数据。';
const SOURCE_FIELD_NAMES = [
  '告警内容',
  '楼栋',
  '告警分类',
  '确认人',
  '具体位置',
  '监控对象',
  '确认时间',
  '确认描述',
  '产生时间',
  '受理时间',
  '创建时间',
  '受理人',
  '受理描述',
  '处理状态',
  '等级',
  '恢复状态',
  '预期外/预期内',
  '更新时间',
  ALARM_REVIEW_FIELD,
  ALARM_REVIEW_PERSON_FIELD,
  ALARM_REVIEW_REPLY_FIELD,
] as const;
const ALARM_LEVEL_ORDER = ['紧急', '严重', '重要', '次要', '预警', '未设置'];
const PROCESSING_STATUS_ORDER = ['未处理', '处理中', '已处理', '未设置'];
const RECOVERY_STATUS_ORDER = ['未恢复', '已恢复', '未设置'];
const ALARM_STATUSES: TodayOperationsAlarmHandlingStatus[] = [
  '未恢复',
  '处理中',
  '已关闭',
];
const TAG_ISSUE_CODES: TodayOperationsAlarmTagIssueCode[] = [
  'missing', 'format', 'pending', 'vague', 'nonOfficial', 'semantic',
];

interface AlarmSnapshot {
  records: BitableRecordItem[];
  expiresAt: number;
  syncedAt: string;
  sourceStatus: 'fresh' | 'stale';
  windowKey: string;
}

interface AlarmSourceResult {
  records: BitableRecordItem[];
  syncedAt: string;
  sourceStatus: 'fresh' | 'stale';
}

interface MappedAlarm extends TodayOperationsAlarmItem {
  occurredAtMs: number;
  searchText: string;
}

@Injectable()
export class TodayOperationsAlarmService {
  private lastGoodSnapshot: AlarmSnapshot | null = null;
  private readonly semanticReviewer: AlarmTagSemanticReviewer;

  constructor(
    @Inject(HttpService)
    private readonly httpService: HttpService,
  ) {
    this.semanticReviewer = getAlarmTagSemanticReviewer(httpService);
  }

  patchHumanReview(recordId: string, fields: Record<string, unknown>): void {
    if (!this.lastGoodSnapshot) return;
    this.lastGoodSnapshot.records = this.lastGoodSnapshot.records.map((record) => getRecordId(record) === recordId
      ? { ...record, fields: { ...record.fields, [ALARM_REVIEW_FIELD]: fields[ALARM_REVIEW_FIELD], [ALARM_REVIEW_PERSON_FIELD]: fields[ALARM_REVIEW_PERSON_FIELD], [ALARM_REVIEW_REPLY_FIELD]: fields[ALARM_REVIEW_REPLY_FIELD] } }
      : record);
  }

  async getDashboard(
    query: TodayOperationsAlarmDashboardQuery,
  ): Promise<TodayOperationsAlarmDashboardResponse> {
    const now = new Date();
    const window = query.date === undefined
      ? createTodayOperationsAlarmWindow(now)
      : createTodayOperationsAlarmDayWindow(query.date, now);
    const windowKey = `${window.startDate}:${window.endDateExclusive}`;
    const forceRefresh = isTruthyQueryFlag(query.refresh);
    const cachedSnapshot =
      !forceRefresh &&
      this.lastGoodSnapshot?.windowKey === windowKey &&
      this.lastGoodSnapshot.expiresAt > now.getTime()
        ? this.lastGoodSnapshot
        : null;

    if (cachedSnapshot) {
      return mapDashboard(
        cachedSnapshot.records,
        window,
        query,
        cachedSnapshot.syncedAt,
        cachedSnapshot.sourceStatus,
        this.semanticReviewer,
      );
    }

    try {
      const source = await this.fetchSourceRecords(window, forceRefresh);
      this.lastGoodSnapshot = {
        records: source.records,
        expiresAt:
          now.getTime() +
          (source.sourceStatus === 'fresh'
            ? SOURCE_CACHE_TTL_MS
            : STALE_SNAPSHOT_RETRY_MS),
        syncedAt: source.syncedAt,
        sourceStatus: source.sourceStatus,
        windowKey,
      };
      return mapDashboard(
        source.records,
        window,
        query,
        source.syncedAt,
        source.sourceStatus,
        this.semanticReviewer,
      );
    } catch {
      if (this.lastGoodSnapshot?.windowKey === windowKey) {
        return mapDashboard(
          this.lastGoodSnapshot.records,
          window,
          query,
          this.lastGoodSnapshot.syncedAt,
          'stale',
          this.semanticReviewer,
        );
      }
      throw new ServiceUnavailableException(
        '今日全景告警数据暂时不可用，请稍后重试。',
      );
    }
  }

  private async fetchSourceRecords(
    window: TodayOperationsAlarmWindow,
    forceRefresh: boolean,
  ): Promise<AlarmSourceResult> {
    const source = parseFeishuBitableLink(
      readEnv('TODAY_OPERATIONS_ALARM_BITABLE_URL') || DEFAULT_ALARM_SOURCE_URL,
    );
    const auth = resolveTodayOperationsAlarmAuth();
    const viewId = source.viewId || undefined;
    const filter = buildTodayOperationsAlarmSourceFilter(window);
    const sort = [{ field_name: '产生时间', desc: true }] as const;

    try {
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken: source.appToken,
        wikiToken: source.wikiToken,
        tableName: SOURCE_TABLE_NAME,
        auth,
      });
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: source.tableId,
        viewId,
        fieldNames: SOURCE_FIELD_NAMES,
        filter,
        sort,
        tableName: SOURCE_TABLE_NAME,
        cacheTtlMs: SOURCE_CACHE_TTL_MS,
        forceRefresh,
        strict: true,
        auth,
      });
      return {
        records,
        syncedAt: new Date().toISOString(),
        sourceStatus: 'fresh',
      };
    } catch (error) {
      const persisted = await readLatestPersistedBitableRecordSnapshot({
        tableId: source.tableId,
        tableName: SOURCE_TABLE_NAME,
        viewId,
        fieldNames: SOURCE_FIELD_NAMES,
        filter,
        sort,
      });
      if (persisted) {
        return {
          records: persisted.records,
          syncedAt: new Date(persisted.fetchedAt).toISOString(),
          sourceStatus: 'stale',
        };
      }
      throw error;
    }
  }
}

export function buildTodayOperationsAlarmSourceFilter(
  window: TodayOperationsAlarmWindow,
): BitableRecordSearchFilter {
  const lowerBoundMs = parseShanghaiDateStart(window.startDate) - DAY_MS;
  const upperBoundMs = parseShanghaiDateStart(window.endDateExclusive);
  return {
    conjunction: 'and',
    conditions: [
      {
        field_name: '产生时间',
        operator: 'isGreater',
        value: ['ExactDate', String(lowerBoundMs)],
      },
      {
        field_name: '产生时间',
        operator: 'isLess',
        value: ['ExactDate', String(upperBoundMs)],
      },
    ],
  };
}

export function createTodayOperationsAlarmWindow(
  now: Date,
): TodayOperationsAlarmWindow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const todayStartMs =
    Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
    ) - SHANGHAI_UTC_OFFSET_MS;

  return {
    timeZone: 'Asia/Shanghai',
    startDate: formatShanghaiDate(todayStartMs - 7 * DAY_MS),
    endDateExclusive: formatShanghaiDate(todayStartMs),
    yesterdayDate: formatShanghaiDate(todayStartMs - DAY_MS),
  };
}

export function createTodayOperationsAlarmDayWindow(
  date: string,
  now = new Date(),
): TodayOperationsAlarmWindow {
  const timestamp = parseShanghaiDateStart(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(timestamp) || formatShanghaiDate(timestamp) !== date ||
      date >= createTodayOperationsAlarmWindow(now).endDateExclusive) {
    throw new BadRequestException('告警日期须为已结束的自然日，格式 YYYY-MM-DD');
  }
  return {
    timeZone: 'Asia/Shanghai',
    startDate: date,
    endDateExclusive: formatShanghaiDate(timestamp + DAY_MS),
    yesterdayDate: date,
  };
}

function mapDashboard(
  records: BitableRecordItem[],
  window: TodayOperationsAlarmWindow,
  query: TodayOperationsAlarmDashboardQuery,
  syncedAt: string,
  sourceStatus: 'fresh' | 'stale',
  semanticReviewer: AlarmTagSemanticReviewer,
): TodayOperationsAlarmDashboardResponse {
  const startMs = parseShanghaiDateStart(window.startDate);
  const endMs = parseShanghaiDateStart(window.endDateExclusive);
  const yesterdayStartMs = parseShanghaiDateStart(window.yesterdayDate);
  const seenIds = new Set<string>();
  const alarms = records
    .map(mapAlarm)
    .filter(
      (alarm): alarm is MappedAlarm =>
        Boolean(alarm) &&
        alarm.occurredAtMs >= startMs &&
        alarm.occurredAtMs < endMs,
    )
    .filter((alarm) => {
      if (seenIds.has(alarm.id)) return false;
      seenIds.add(alarm.id);
      return true;
    })
    .sort(
      (left, right) =>
        right.occurredAtMs - left.occurredAtMs ||
        left.id.localeCompare(right.id, 'zh-CN'),
    );
  const tagReview = semanticReviewer.snapshot(
    alarms.map((alarm) => ({
      id: alarm.id,
      description: alarm.description,
      location: alarm.location,
      monitorObject: alarm.monitorObject,
      acceptanceDescription: alarm.acceptanceDescription,
      confirmationDescription: alarm.confirmationDescription,
    })),
  );
  for (const alarm of alarms) {
    alarm.tagIssues = [
      ...alarm.tagIssues,
      ...(tagReview.issuesById.get(alarm.id) || []),
    ];
  }
  const tagAnomalies = alarms.filter((alarm) => alarm.tagIssues.length > 0);
  const tagAnomalyByBuilding = [
    ...new Set([
      ...TODAY_OPERATIONS_ALARM_BUILDINGS,
      ...tagAnomalies.map((alarm) => alarm.building),
    ]),
  ]
    .map((building) => {
      const buildingAlarms = tagAnomalies.filter(
        (alarm) => alarm.building === building,
      );
      return {
        building,
        total: buildingAlarms.length,
        byType: Object.fromEntries(
          TAG_ISSUE_CODES.map((code) => [
            code,
            buildingAlarms.filter((alarm) =>
              alarm.tagIssues.some((issue) => issue.code === code),
            ).length,
          ]),
        ) as Record<TodayOperationsAlarmTagIssueCode, number>,
      };
    })
    .sort((left, right) => right.total - left.total || left.building.localeCompare(right.building, 'zh-CN'));
  const yesterdayAlarms = alarms.filter(
    (alarm) =>
      alarm.occurredAtMs >= yesterdayStartMs && alarm.occurredAtMs < endMs,
  );
  const dayBeforeYesterdayAlarms = alarms.filter(
    (alarm) =>
      alarm.occurredAtMs >= yesterdayStartMs - DAY_MS &&
      alarm.occurredAtMs < yesterdayStartMs,
  );
  const summary = {
    sevenDayTotal: alarms.length,
    expectedTotal: countExpectation(alarms, 'expected'),
    unexpectedTotal: countExpectation(alarms, 'unexpected'),
    unclassifiedTotal: countExpectation(alarms, 'unclassified'),
    yesterdayTotal: yesterdayAlarms.length,
    yesterdayExpectedTotal: countExpectation(yesterdayAlarms, 'expected'),
    yesterdayUnexpectedTotal: countExpectation(yesterdayAlarms, 'unexpected'),
    yesterdayUnclassifiedTotal: countExpectation(
      yesterdayAlarms,
      'unclassified',
    ),
    dayBeforeYesterdayTotal: dayBeforeYesterdayAlarms.length,
    pendingTotal: alarms.filter((alarm) => alarm.handlingStatus !== '已关闭')
      .length,
    doubleUnhandledTotal: alarms.filter(isDoubleUnhandled).length,
    excludedBuildingTotal: alarms.filter(
      (alarm) =>
        !TODAY_OPERATIONS_ALARM_BUILDINGS.includes(
          alarm.building as TodayOperationsAlarmChartBuilding,
        ),
    ).length,
    tagAnomalyTotal: tagAnomalies.length,
    tagAnomalyByType: Object.fromEntries(
      TAG_ISSUE_CODES.map((code) => [
        code,
        alarms.filter((alarm) => alarm.tagIssues.some((issue) => issue.code === code)).length,
      ]),
    ) as Record<TodayOperationsAlarmTagIssueCode, number>,
    tagAnomalyByBuilding,
  };
  const metricAlarms = applyMetricFilter(alarms, yesterdayAlarms, query.metric);
  const filtered = applyQueryFilters(metricAlarms, query);
  const pageSize = normalizePositiveInteger(
    query.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const totalPages = filtered.length
    ? Math.ceil(filtered.length / pageSize)
    : 0;
  const requestedPage = normalizePositiveInteger(
    query.page,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const page = totalPages ? Math.min(requestedPage, totalPages) : 1;
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
  const sourceUpdatedAt = alarms.reduce<string | null>(
    (latest, alarm) =>
      !latest || alarm.createdAt > latest ? alarm.createdAt : latest,
    null,
  );

  return {
    window,
    summary,
    sevenDayByBuilding: buildBuildingSeries(alarms),
    yesterdayByBuilding: buildBuildingSeries(yesterdayAlarms),
    options: {
      buildings: buildBuildingOptions(alarms),
      levels: buildSortedOptions(
        alarms.map((alarm) => alarm.level),
        ALARM_LEVEL_ORDER,
      ),
      statuses: ALARM_STATUSES,
      processingStatuses: buildSortedOptions(
        alarms.map((alarm) => alarm.processingStatus),
        PROCESSING_STATUS_ORDER,
      ),
      recoveryStatuses: buildSortedOptions(
        alarms.map((alarm) => alarm.recoveryStatus),
        RECOVERY_STATUS_ORDER,
      ),
    },
    page: {
      items: pageItems.map(stripInternalAlarmFields),
      page,
      pageSize,
      total: filtered.length,
      totalPages,
    },
    sourceUpdatedAt,
    syncedAt,
    sourceStatus,
    dataStatus: alarms.length ? 'ready' : 'empty',
    warnings: sourceStatus === 'stale' ? [STALE_WARNING] : [],
    tagReview: tagReview.status,
  };
}

function mapAlarm(record: BitableRecordItem): MappedAlarm | null {
  const fields = record.fields || {};
  const occurredAt = extractDateTimeIso(fields['产生时间']);
  if (!occurredAt) return null;
  const occurredAtMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredAtMs)) return null;

  const building = normalizeBuilding(extractDisplayText(fields['楼栋']));
  const description = displayOrDash(fields['告警内容']);
  const location = displayOrDash(fields['具体位置']);
  const alarmCategory = displayOrDash(fields['告警分类']);
  const monitorObject = extractDisplayText(fields['监控对象']).trim();
  const acceptanceDescription = extractDisplayText(fields['受理描述']).trim();
  const confirmationDescription = extractDisplayText(fields['确认描述']).trim();
  const confirmationOwner = extractDisplayText(fields['确认人']).trim();
  const acceptanceOwner = extractDisplayText(fields['受理人']).trim();
  const owner = confirmationOwner || acceptanceOwner || '—';
  const acceptedAt = extractDateTimeIso(fields['受理时间']) || '';
  const createdAt =
    extractDateTimeIso(fields['创建时间']) ||
    extractDateTimeIso(fields['更新时间']) ||
    occurredAt;
  const confirmationStatus = [
    fields['确认人'],
    fields['确认时间'],
    fields['确认描述'],
  ].some(hasDisplayValue)
    ? '已确认'
    : '待确认';
  const processingStatus = mapSourceOption(fields['处理状态']);
  const recoveryStatus = mapSourceOption(fields['恢复状态']);
  const handlingStatus = mapHandlingStatus(processingStatus, recoveryStatus);
  const expectation = mapExpectation(fields['预期外/预期内']);
  const level = mapSourceOption(fields['等级']);
  const handlingDescription =
    confirmationDescription ||
    acceptanceDescription ||
    '—';
  const tagIssues = detectAlarmTagRuleIssues({
    processingStatus,
    acceptanceDescription,
    confirmationDescription,
  });
  const searchText = [
    getRecordId(record),
    description,
    building,
    location,
    monitorObject,
    alarmCategory,
    owner,
    handlingDescription,
    acceptanceDescription,
    confirmationDescription,
    ...tagIssues.map((issue) => issue.reason),
    processingStatus,
    recoveryStatus,
  ]
    .join('\n')
    .toLocaleLowerCase('zh-CN');

  return {
    id: getRecordId(record),
    ...(ALARM_REVIEW_OUTCOMES.includes(extractDisplayText(fields[ALARM_REVIEW_FIELD]).trim() as AlarmReviewOutcome) ? {
      humanReview: { outcome: extractDisplayText(fields[ALARM_REVIEW_FIELD]).trim() as AlarmReviewOutcome,
        ...(extractDisplayText(fields[ALARM_REVIEW_FIELD]).trim() === '自定义回复' ? { customReply: readAlarmReviewReply(fields[ALARM_REVIEW_REPLY_FIELD]).trim() } : {}),
        responsibleName: extractDisplayText(fields[ALARM_REVIEW_PERSON_FIELD]).trim(), version: reviewVersion(fields) },
    } : {}),
    description,
    building,
    level,
    expectation,
    occurredAt,
    acceptedAt,
    handlingDescription,
    acceptanceDescription,
    confirmationDescription,
    monitorObject,
    tagIssues,
    owner,
    confirmationStatus,
    handlingStatus,
    processingStatus,
    recoveryStatus,
    createdAt,
    location,
    alarmCategory,
    occurredAtMs,
    searchText,
  };
}

function mapSourceOption(field: unknown): string {
  return extractDisplayText(field).trim() || EMPTY_SOURCE_OPTION;
}

function mapExpectation(field: unknown): TodayOperationsAlarmExpectation {
  const value = extractDisplayText(field).trim();
  if (value.includes('预期外')) return 'unexpected';
  if (value.includes('预期内')) return 'expected';
  return 'unclassified';
}

function mapHandlingStatus(
  processingStatus: string,
  recoveryStatus: string,
): TodayOperationsAlarmHandlingStatus {
  if (processingStatus === '已处理' && recoveryStatus === '已恢复') {
    return '已关闭';
  }
  if (processingStatus === '处理中') return '处理中';
  return '未恢复';
}

function isDoubleUnhandled(alarm: MappedAlarm): boolean {
  return (
    alarm.processingStatus === '未处理' && alarm.recoveryStatus === '未恢复'
  );
}

function applyQueryFilters(
  alarms: MappedAlarm[],
  query: TodayOperationsAlarmDashboardQuery,
): MappedAlarm[] {
  const building = query.building?.trim();
  const level = query.level?.trim();
  const status = query.status?.trim();
  const processingStatus = query.processingStatus?.trim();
  const recoveryStatus = query.recoveryStatus?.trim();
  const search = query.q?.trim().toLocaleLowerCase('zh-CN');

  return alarms.filter(
    (alarm) =>
      (!building || alarm.building === building) &&
      (!level || alarm.level === level) &&
      (!status || alarm.handlingStatus === status) &&
      (!processingStatus || alarm.processingStatus === processingStatus) &&
      (!recoveryStatus || alarm.recoveryStatus === recoveryStatus) &&
      (!query.tagIssueCode || alarm.tagIssues.some((issue) => issue.code === query.tagIssueCode)) &&
      (!search || alarm.searchText.includes(search)),
  );
}

function applyMetricFilter(
  alarms: MappedAlarm[],
  yesterdayAlarms: MappedAlarm[],
  metric: string | undefined,
): MappedAlarm[] {
  switch (metric?.trim()) {
    case 'expected':
      return alarms.filter((alarm) => alarm.expectation === 'expected');
    case 'unexpected':
      return alarms.filter((alarm) => alarm.expectation === 'unexpected');
    case 'unclassified':
      return alarms.filter((alarm) => alarm.expectation === 'unclassified');
    case 'yesterday':
      return yesterdayAlarms;
    case 'yesterdayExpected':
      return yesterdayAlarms.filter(
        (alarm) => alarm.expectation === 'expected',
      );
    case 'yesterdayUnexpected':
      return yesterdayAlarms.filter(
        (alarm) => alarm.expectation === 'unexpected',
      );
    case 'yesterdayUnclassified':
      return yesterdayAlarms.filter(
        (alarm) => alarm.expectation === 'unclassified',
      );
    case 'pending':
      return alarms.filter((alarm) => alarm.handlingStatus !== '已关闭');
    case 'doubleUnhandled':
      return alarms.filter(isDoubleUnhandled);
    case 'tagAnomaly':
      return alarms.filter((alarm) => alarm.tagIssues.length > 0);
    default:
      return alarms;
  }
}

function buildBuildingSeries(
  alarms: MappedAlarm[],
): TodayOperationsAlarmBuildingPoint[] {
  return TODAY_OPERATIONS_ALARM_BUILDINGS.map((building) => {
    const buildingAlarms = alarms.filter(
      (alarm) => alarm.building === building,
    );
    return {
      building,
      expected: countExpectation(buildingAlarms, 'expected'),
      unexpected: countExpectation(buildingAlarms, 'unexpected'),
      unclassified: countExpectation(buildingAlarms, 'unclassified'),
      total: buildingAlarms.length,
    };
  });
}

function countExpectation(
  alarms: MappedAlarm[],
  expectation: TodayOperationsAlarmExpectation,
): number {
  return alarms.filter((alarm) => alarm.expectation === expectation).length;
}

function buildBuildingOptions(alarms: MappedAlarm[]): string[] {
  const values = [...new Set(alarms.map((alarm) => alarm.building))];
  return values.sort((left, right) => {
    const leftIndex = TODAY_OPERATIONS_ALARM_BUILDINGS.indexOf(
      left as TodayOperationsAlarmChartBuilding,
    );
    const rightIndex = TODAY_OPERATIONS_ALARM_BUILDINGS.indexOf(
      right as TodayOperationsAlarmChartBuilding,
    );
    if (leftIndex >= 0 || rightIndex >= 0) {
      if (leftIndex < 0) return 1;
      if (rightIndex < 0) return -1;
      return leftIndex - rightIndex;
    }
    return left.localeCompare(right, 'zh-CN');
  });
}

function buildSortedOptions(
  values: string[],
  preferredOrder: readonly string[],
): string[] {
  const unique = [...new Set(values)];
  const rank = new Map(preferredOrder.map((value, index) => [value, index]));
  return unique.sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right, 'zh-CN');
  });
}

function stripInternalAlarmFields(
  alarm: MappedAlarm,
): TodayOperationsAlarmItem {
  const {
    occurredAtMs: _occurredAtMs,
    searchText: _searchText,
    ...item
  } = alarm;
  return item;
}

function normalizeBuilding(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '未标注';
  if (normalized.includes('测试')) return '测试楼栋';
  const building = normalized.toUpperCase().match(/([A-E])(?:楼|栋)?/u)?.[1];
  return building ? `${building}楼` : normalized;
}

function displayOrDash(field: unknown): string {
  return extractDisplayText(field).trim() || '—';
}

function hasDisplayValue(field: unknown): boolean {
  return extractDisplayText(field).trim().length > 0;
}

export function resolveTodayOperationsAlarmAuth():
  | FeishuBitableAuthConfig
  | undefined {
  const candidates = [
    [
      readEnv('TODAY_OPERATIONS_ALARM_FEISHU_APP_ID'),
      readEnv('TODAY_OPERATIONS_ALARM_FEISHU_APP_SECRET'),
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

function normalizePositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!value || !/^\d+$/u.test(value.trim())) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function isTruthyQueryFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function parseShanghaiDateStart(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

function formatShanghaiDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}
