import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  WeatherWarningBuilding,
  WeatherWarningBuildingProgress,
  WeatherWarningBuildingProgressSummary,
  WeatherWarningCheckKey,
  WeatherWarningGuardCompletionSummary,
  WeatherWarningIncompleteItem,
} from '@shared/api.interface';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
} from '@server/common/feishu/bitable-direct-read';
import {
  loadWeatherWarningCheckRuntimeConfig,
  loadWeatherWarningRuleRuntimeConfig,
  loadWeatherWarningRuntimeConfig,
  type WeatherWarningCheckRuntimeConfig,
  type WeatherWarningRuleRuntimeConfig,
  type WeatherWarningRuntimeConfig,
  type WeatherWarningSourceRuntimeConfig,
} from './weather-warning.config';
import {
  normalizeWeatherWarningColor,
  type WeatherGuardLevel,
  type WeatherWarningRule,
} from './weather-warning-rules';

export type WeatherWarningCheckState =
  | 'completed'
  | 'pending'
  | 'abnormal'
  | 'not_started'
  | 'not_required';

export interface WeatherWarningCheckSummary {
  device: WeatherWarningCheckState;
  environment: WeatherWarningCheckState;
  disaster: WeatherWarningCheckState;
  materials: WeatherWarningCheckState;
  contacts: WeatherWarningCheckState;
  managerConfirmation: WeatherWarningCheckState;
  abnormalSummaries: string[];
}

interface CheckFieldDefinition {
  key: WeatherWarningCheckKey;
  stateField: keyof WeatherWarningCheckRuntimeConfig['checkFields'];
  issueField?: keyof WeatherWarningCheckRuntimeConfig['checkFields'];
  evidenceField?: keyof WeatherWarningCheckRuntimeConfig['checkFields'];
  label: string;
  progressLabel: string;
}

interface DatedCheckRecord {
  record: unknown;
  timestamp: number;
  id: string;
}

interface ParsedCheckDate {
  timestamp: number;
  precision: 'instant' | 'shanghai_day';
}

interface CheckRecordLoadResult {
  records: unknown[];
  buildingAvailable: boolean;
}

export interface WeatherWarningCheckProgressResult {
  summary: WeatherWarningCheckSummary;
  buildingProgress: WeatherWarningBuildingProgressSummary;
  guardCompletion: WeatherWarningGuardCompletionSummary;
}

const RULE_CACHE_TTL_MS = 10 * 60 * 1000;
const CHECK_CACHE_TTL_MS = 60 * 1000;
const RULE_RUNTIME_VARIABLES = [
  'FEISHU_WEATHER_WARNING_SOURCE_URL',
  'FEISHU_WEATHER_WARNING_RULE_TABLE_ID',
  'FEISHU_WEATHER_WARNING_RULE_TYPE_FIELD',
  'FEISHU_WEATHER_WARNING_RULE_COLOR_FIELD',
  'FEISHU_WEATHER_WARNING_RULE_GUARD_FIELD',
] as const;
const CHECK_RUNTIME_VARIABLES = [
  'FEISHU_WEATHER_WARNING_SOURCE_URL',
  'FEISHU_WEATHER_WARNING_CHECK_TABLE_ID',
  'FEISHU_WEATHER_WARNING_CHECK_DATE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_BUILDING_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_GUARD_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_TAG_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DEVICE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DEVICE_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DEVICE_EVIDENCE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_EVIDENCE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DISASTER_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DISASTER_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_DISASTER_EVIDENCE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_MATERIALS_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_MATERIALS_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_CONTACTS_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_CONTACTS_ISSUE_FIELD',
  'FEISHU_WEATHER_WARNING_CHECK_MANAGER_CONFIRMATION_FIELD',
] as const;
const FIELD_WRAPPER_KEYS = [
  'text',
  'name',
  'label',
  'value',
  'select',
  'date',
  'timestamp',
  'users',
  'title',
] as const;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_WITH_TIMEZONE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_NAME = '南通天气预警';
const RULE_TABLE_NAME = '南通天气预警-重保类型对应表';
const CHECK_TABLE_NAME = '南通天气预警-重保检查表';
export const WEATHER_WARNING_EXPECTED_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
] as const satisfies readonly WeatherWarningBuilding[];
const CHECK_FIELD_DEFINITIONS: readonly CheckFieldDefinition[] = [
  {
    key: 'device',
    stateField: 'device',
    issueField: 'deviceIssue',
    evidenceField: 'deviceEvidence',
    label: '设备',
    progressLabel: '设备安全',
  },
  {
    key: 'environment',
    stateField: 'environment',
    issueField: 'environmentIssue',
    evidenceField: 'environmentEvidence',
    label: '环境',
    progressLabel: '环境安全',
  },
  {
    key: 'disaster',
    stateField: 'disaster',
    issueField: 'disasterIssue',
    evidenceField: 'disasterEvidence',
    label: '灾害',
    progressLabel: '灾害专项',
  },
  {
    key: 'materials',
    stateField: 'materials',
    issueField: 'materialsIssue',
    label: '物资',
    progressLabel: '物资清单',
  },
  {
    key: 'contacts',
    stateField: 'contacts',
    issueField: 'contactsIssue',
    label: '联络',
    progressLabel: '联络清单',
  },
  {
    key: 'managerConfirmation',
    stateField: 'managerConfirmation',
    label: '机房经理确认',
    progressLabel: '机房经理确认',
  },
];
@Injectable()
export class WeatherWarningBitableService {
  constructor(private readonly httpService: HttpService) {}

  getRuntimeConfig(): WeatherWarningRuntimeConfig {
    return loadWeatherWarningRuntimeConfig();
  }

  async getRules(forceRefresh = false): Promise<WeatherWarningRule[]> {
    try {
      const config = loadWeatherWarningRuleRuntimeConfig();
      const appToken = await this.resolveAppToken(config);
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId: config.ruleTableId,
        tableName: RULE_TABLE_NAME,
        fieldNames: Object.values(config.ruleFields),
        cacheTtlMs: RULE_CACHE_TTL_MS,
        forceRefresh,
        allowStale: false,
        strict: true,
      });

      return getRecordList(records).flatMap((record) =>
        mapWeatherWarningRule(record, config),
      );
    } catch {
      throw createBaseUnavailableException(RULE_RUNTIME_VARIABLES);
    }
  }

  async getCheckSummary(
    guardLevel: WeatherGuardLevel,
    tag: string,
    forceRefresh = false,
  ): Promise<WeatherWarningCheckSummary> {
    try {
      const config = loadWeatherWarningCheckRuntimeConfig();
      const appToken = await this.resolveAppToken(config);
      const { records } = await this.loadCheckRecords(
        config,
        appToken,
        forceRefresh,
      );
      const latestRecord = findLatestCheckRecord(
        records,
        config,
        guardLevel,
        tag,
      );

      return latestRecord
        ? mapCheckSummary(latestRecord, config)
        : createNotStartedCheckSummary();
    } catch {
      throw createBaseUnavailableException(CHECK_RUNTIME_VARIABLES);
    }
  }

  async getCheckProgress(
    guardLevel: WeatherGuardLevel,
    tag: string,
    eventOpenedAt: string,
    requiredCheckKeys?: readonly WeatherWarningCheckKey[],
    forceRefresh = false,
  ): Promise<WeatherWarningCheckProgressResult> {
    try {
      const openedAtTimestamp = parseTimestamp(eventOpenedAt);
      if (openedAtTimestamp === null) {
        throw new Error('Invalid weather warning event start time');
      }

      const config = loadWeatherWarningCheckRuntimeConfig();
      const appToken = await this.resolveAppToken(config);
      const { records, buildingAvailable } = await this.loadCheckRecords(
        config,
        appToken,
        forceRefresh,
      );
      const candidates = findCheckRecordCandidates(
        records,
        config,
        guardLevel,
        tag,
        openedAtTimestamp,
      );
      const requiredKeys = new Set(
        requiredCheckKeys ?? CHECK_FIELD_DEFINITIONS.map(({ key }) => key),
      );
      const summary = candidates[0]
        ? mapCheckSummary(candidates[0].record, config, requiredKeys)
        : createNotStartedCheckSummary(requiredKeys);

      const buildingProgress = buildingAvailable
        ? mapBuildingProgress(candidates, config, requiredKeys)
        : createUnavailableBuildingProgress();

      return {
        summary,
        buildingProgress,
        guardCompletion: mapGuardCompletion(buildingProgress, requiredKeys),
      };
    } catch {
      throw createBaseUnavailableException(CHECK_RUNTIME_VARIABLES);
    }
  }

  private async loadCheckRecords(
    config: WeatherWarningCheckRuntimeConfig,
    appToken: string,
    forceRefresh: boolean,
  ): Promise<CheckRecordLoadResult> {
    try {
      const records = await this.fetchCheckRecords(
        config,
        appToken,
        Object.values(config.checkFields),
        forceRefresh,
      );
      return { records, buildingAvailable: true };
    } catch (error) {
      if (!isExplicitMissingBitableFieldError(error)) throw error;

      const records = await this.fetchCheckRecords(
        config,
        appToken,
        Object.entries(config.checkFields)
          .filter(([key]) => key !== 'building')
          .map(([, fieldName]) => fieldName),
        forceRefresh,
      );
      return { records, buildingAvailable: false };
    }
  }

  private async fetchCheckRecords(
    config: WeatherWarningCheckRuntimeConfig,
    appToken: string,
    fieldNames: string[],
    forceRefresh: boolean,
  ): Promise<unknown[]> {
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: config.checkTableId,
      tableName: CHECK_TABLE_NAME,
      fieldNames,
      cacheTtlMs: CHECK_CACHE_TTL_MS,
      forceRefresh,
      allowStale: false,
      strict: true,
    });
    return getRecordList(records);
  }

  private async resolveAppToken(
    config: WeatherWarningSourceRuntimeConfig,
  ): Promise<string> {
    try {
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken: config.appToken,
        wikiToken: config.wikiToken,
        tableName: SOURCE_NAME,
      });
      if (appToken) return appToken;
    } catch {
      // The public error intentionally omits provider and credential details.
    }
    throw createBaseUnavailableException(['FEISHU_WEATHER_WARNING_SOURCE_URL']);
  }
}

function createBaseUnavailableException(
  variableNames: readonly string[],
): ServiceUnavailableException {
  return new ServiceUnavailableException(
    `Weather warning Base unavailable: ${variableNames.join(', ')}`,
  );
}

function mapWeatherWarningRule(
  record: unknown,
  config: WeatherWarningRuleRuntimeConfig,
): WeatherWarningRule[] {
  const fields = getRecordFields(record);
  const warningType = getFieldText(
    getOwnRecordValue(fields, config.ruleFields.type),
  );
  const warningColor = normalizeWeatherWarningColor(
    getFieldText(getOwnRecordValue(fields, config.ruleFields.color)),
  );
  const guardLevel = getFieldText(
    getOwnRecordValue(fields, config.ruleFields.guard),
  );
  if (!warningType || !warningColor || !isWeatherGuardLevel(guardLevel)) {
    return [];
  }

  return [
    {
      warningType,
      warningColor,
      guardLevel,
    },
  ];
}

function findLatestCheckRecord(
  records: readonly unknown[],
  config: WeatherWarningCheckRuntimeConfig,
  guardLevel: WeatherGuardLevel,
  tag: string,
): unknown | null {
  return (
    findCheckRecordCandidates(
      records,
      config,
      guardLevel,
      tag,
      Number.NEGATIVE_INFINITY,
    )[0]?.record ?? null
  );
}

function findCheckRecordCandidates(
  records: readonly unknown[],
  config: WeatherWarningCheckRuntimeConfig,
  guardLevel: WeatherGuardLevel,
  tag: string,
  openedAtTimestamp: number,
): DatedCheckRecord[] {
  const normalizedTag = normalizeText(tag);
  if (!normalizedTag) return [];

  const candidates = records.flatMap((record): DatedCheckRecord[] => {
    const fields = getRecordFields(record);
    if (
      !fields ||
      !hasExactFieldValue(
        getOwnRecordValue(fields, config.checkFields.guard),
        guardLevel,
      ) ||
      !hasExactFieldValue(
        getOwnRecordValue(fields, config.checkFields.tag),
        normalizedTag,
      )
    ) {
      return [];
    }

    const recordDate = getFieldDate(
      getOwnRecordValue(fields, config.checkFields.date),
    );
    if (
      !recordDate ||
      !isRecordDateInsideEventWindow(recordDate, openedAtTimestamp)
    ) {
      return [];
    }

    return [
      {
        record,
        timestamp: recordDate.timestamp,
        id: getRecordIdentifier(record),
      },
    ];
  });
  candidates.sort(
    (left, right) =>
      right.timestamp - left.timestamp || left.id.localeCompare(right.id),
  );
  return candidates;
}

function mapBuildingProgress(
  candidates: readonly DatedCheckRecord[],
  config: WeatherWarningCheckRuntimeConfig,
  requiredKeys: ReadonlySet<WeatherWarningCheckKey>,
): WeatherWarningBuildingProgressSummary {
  const latestByBuilding = new Map<WeatherWarningBuilding, DatedCheckRecord>();
  let unassignedRecordCount = 0;

  for (const candidate of candidates) {
    const fields = getRecordFields(candidate.record);
    const building = getWeatherWarningBuilding(
      getOwnRecordValue(fields, config.checkFields.building),
    );
    if (!building) {
      unassignedRecordCount += 1;
      continue;
    }
    if (!latestByBuilding.has(building)) {
      latestByBuilding.set(building, candidate);
    }
  }

  const buildings = WEATHER_WARNING_EXPECTED_BUILDINGS.flatMap(
    (building): WeatherWarningBuildingProgress[] => {
      const candidate = latestByBuilding.get(building);
      if (!candidate) return [];
      const summary = mapCheckSummary(
        candidate.record,
        config,
        requiredKeys,
        true,
      );
      return [
        {
          building,
          recordAt: new Date(candidate.timestamp).toISOString(),
          checks: toCheckStateRecord(summary),
          abnormalSummaries: [...summary.abnormalSummaries],
        },
      ];
    },
  );
  const missingRegistrationBuildings =
    WEATHER_WARNING_EXPECTED_BUILDINGS.filter(
      (building) => !latestByBuilding.has(building),
    );
  const incompleteItems = [
    ...buildings.flatMap((buildingProgress) =>
      getBuildingIncompleteItems(
        buildingProgress,
        latestByBuilding,
        config,
        requiredKeys,
      ),
    ),
    ...missingRegistrationBuildings.map(
      (building): WeatherWarningIncompleteItem => ({
        building,
        key: 'registration',
        label: '未提交戒备登记',
        state: 'missing_registration',
      }),
    ),
  ];

  return {
    available: true,
    buildings,
    missingRegistrationBuildings,
    unassignedRecordCount,
    incompleteItems,
  };
}

function getBuildingIncompleteItems(
  buildingProgress: WeatherWarningBuildingProgress,
  latestByBuilding: ReadonlyMap<WeatherWarningBuilding, DatedCheckRecord>,
  config: WeatherWarningCheckRuntimeConfig,
  requiredKeys: ReadonlySet<WeatherWarningCheckKey>,
): WeatherWarningIncompleteItem[] {
  const candidate = latestByBuilding.get(buildingProgress.building);
  const fields = getRecordFields(candidate?.record) ?? {};

  return CHECK_FIELD_DEFINITIONS.filter((definition) =>
    requiredKeys.has(definition.key),
  ).flatMap((definition): WeatherWarningIncompleteItem[] => {
    const state = buildingProgress.checks[definition.key];
    if (state === 'completed' || state === 'not_required') return [];

    const stateText = getFieldText(
      getOwnRecordValue(fields, config.checkFields[definition.stateField]),
    );
    const issueText = definition.issueField
      ? getFieldText(
          getOwnRecordValue(fields, config.checkFields[definition.issueField]),
        )
      : '';
    const missingEvidence =
      resolveCheckState(stateText, issueText) === 'completed' &&
      definition.evidenceField !== undefined &&
      !hasAttachmentEvidence(
        getOwnRecordValue(fields, config.checkFields[definition.evidenceField]),
      );
    const detail = missingEvidence ? '缺少检查附件' : issueText || stateText;
    return [
      {
        building: buildingProgress.building,
        key: definition.key,
        label: definition.progressLabel,
        state,
        ...(detail ? { detail } : {}),
      },
    ];
  });
}

function toCheckStateRecord(
  summary: WeatherWarningCheckSummary,
): Record<WeatherWarningCheckKey, WeatherWarningCheckState> {
  return {
    device: summary.device,
    environment: summary.environment,
    disaster: summary.disaster,
    materials: summary.materials,
    contacts: summary.contacts,
    managerConfirmation: summary.managerConfirmation,
  };
}

function createUnavailableBuildingProgress(): WeatherWarningBuildingProgressSummary {
  return {
    available: false,
    buildings: [],
    missingRegistrationBuildings: [],
    unassignedRecordCount: 0,
    incompleteItems: [],
  };
}

function mapGuardCompletion(
  buildingProgress: WeatherWarningBuildingProgressSummary,
  requiredKeys: ReadonlySet<WeatherWarningCheckKey>,
): WeatherWarningGuardCompletionSummary {
  const totalBuildingCount = WEATHER_WARNING_EXPECTED_BUILDINGS.length;
  if (!buildingProgress.available) {
    return {
      state: 'unavailable',
      completedBuildingCount: 0,
      totalBuildingCount,
    };
  }

  const completedBuildingCount = buildingProgress.buildings.filter(
    ({ checks }) =>
      [...requiredKeys].every((key) => checks[key] === 'completed'),
  ).length;

  return {
    state:
      completedBuildingCount === totalBuildingCount &&
      buildingProgress.missingRegistrationBuildings.length === 0 &&
      buildingProgress.incompleteItems.length === 0
        ? 'completed'
        : 'incomplete',
    completedBuildingCount,
    totalBuildingCount,
  };
}

function mapCheckSummary(
  record: unknown,
  config: WeatherWarningCheckRuntimeConfig,
  requiredKeys: ReadonlySet<WeatherWarningCheckKey> = new Set(
    CHECK_FIELD_DEFINITIONS.map(({ key }) => key),
  ),
  requireEvidence = false,
): WeatherWarningCheckSummary {
  const fields = getRecordFields(record) ?? {};
  const abnormalSummaries: string[] = [];
  const state = CHECK_FIELD_DEFINITIONS.reduce(
    (summary, definition) => {
      if (!requiredKeys.has(definition.key)) {
        summary[definition.key] = 'not_required';
        return summary;
      }
      const stateText = getFieldText(
        getOwnRecordValue(fields, config.checkFields[definition.stateField]),
      );
      const issueText = definition.issueField
        ? getFieldText(
            getOwnRecordValue(
              fields,
              config.checkFields[definition.issueField],
            ),
          )
        : '';
      const resolvedState = resolveCheckState(stateText, issueText);
      const checkState =
        requireEvidence &&
        resolvedState === 'completed' &&
        definition.evidenceField &&
        !hasAttachmentEvidence(
          getOwnRecordValue(
            fields,
            config.checkFields[definition.evidenceField],
          ),
        )
          ? 'pending'
          : resolvedState;
      summary[definition.key] = checkState;
      if (checkState === 'abnormal') {
        abnormalSummaries.push(
          `${definition.label}：${issueText || stateText || '检查异常'}`,
        );
      }
      return summary;
    },
    {} as Record<
      Exclude<keyof WeatherWarningCheckSummary, 'abnormalSummaries'>,
      WeatherWarningCheckState
    >,
  );

  return {
    device: state.device,
    environment: state.environment,
    disaster: state.disaster,
    materials: state.materials,
    contacts: state.contacts,
    managerConfirmation: state.managerConfirmation,
    abnormalSummaries,
  };
}

function hasAttachmentEvidence(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasAttachmentEvidence);
  if (!isPlainRecord(value)) return false;

  return ['file_token', 'fileToken', 'token', 'url', 'name'].some((key) => {
    const candidate = getOwnRecordValue(value, key);
    return typeof candidate === 'string' && candidate.trim().length > 0;
  });
}

function createNotStartedCheckSummary(
  requiredKeys: ReadonlySet<WeatherWarningCheckKey> = new Set(
    CHECK_FIELD_DEFINITIONS.map(({ key }) => key),
  ),
): WeatherWarningCheckSummary {
  return {
    device: requiredKeys.has('device') ? 'not_started' : 'not_required',
    environment: requiredKeys.has('environment')
      ? 'not_started'
      : 'not_required',
    disaster: requiredKeys.has('disaster') ? 'not_started' : 'not_required',
    materials: requiredKeys.has('materials') ? 'not_started' : 'not_required',
    contacts: requiredKeys.has('contacts') ? 'not_started' : 'not_required',
    managerConfirmation: requiredKeys.has('managerConfirmation')
      ? 'not_started'
      : 'not_required',
    abnormalSummaries: [],
  };
}

function resolveCheckState(
  stateText: string,
  issueText: string,
): WeatherWarningCheckState {
  if (issueText) return 'abnormal';
  if (!stateText) return 'pending';

  const normalized = stateText.replace(/\s+/gu, '').toLowerCase();
  if (isNotStartedCheckValue(normalized)) return 'not_started';
  if (isAbnormalCheckValue(normalized)) return 'abnormal';
  if (isCompletedCheckValue(normalized)) return 'completed';
  return 'pending';
}

function isNotStartedCheckValue(value: string): boolean {
  return [
    '未启动',
    '未开始',
    '尚未启动',
    '尚未开始',
    'not_started',
    'notstarted',
  ].some((marker) => value === marker || value.includes(marker));
}

function isCompletedCheckValue(value: string): boolean {
  return [
    '正常',
    '完成',
    '已完成',
    '已确认',
    '通过',
    '齐备',
    '无异常',
    '无问题',
    '是',
    'true',
    'normal',
    'complete',
    'completed',
    'ok',
  ].some((marker) => value === marker || value.includes(marker));
}

function isAbnormalCheckValue(value: string): boolean {
  if (
    ['无异常', '未发现异常', '无问题', '未发现问题'].some((marker) =>
      value.includes(marker),
    )
  ) {
    return false;
  }
  return [
    '异常',
    '问题',
    '不正常',
    '不通过',
    '未完成',
    '缺失',
    '否',
    'false',
    'abnormal',
    'incomplete',
  ].some((marker) => value === marker || value.includes(marker));
}

function getRecordFields(record: unknown): Record<string, unknown> | null {
  const fields = getOwnRecordValue(record, 'fields');
  return isPlainRecord(fields) ? fields : null;
}

function getWeatherWarningBuilding(
  value: unknown,
): WeatherWarningBuilding | null {
  const values = getFieldTexts(value);
  if (values.length !== 1) return null;
  const building = values[0];
  return WEATHER_WARNING_EXPECTED_BUILDINGS.includes(
    building as WeatherWarningBuilding,
  )
    ? (building as WeatherWarningBuilding)
    : null;
}

function isExplicitMissingBitableFieldError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return Number((error as { feishuCode?: unknown }).feishuCode) === 1254045;
}

function hasExactFieldValue(value: unknown, expected: string): boolean {
  const normalizedExpected = normalizeText(expected);
  return getFieldTexts(value).some(
    (candidate) => normalizeText(candidate) === normalizedExpected,
  );
}

function getFieldDate(value: unknown): ParsedCheckDate | null {
  for (const fieldValue of getFieldTexts(value)) {
    const parsed = parseCheckDate(fieldValue);
    if (parsed) return parsed;
  }
  return null;
}

function parseTimestamp(value: string): number | null {
  return parseCheckDate(value)?.timestamp ?? null;
}

function parseCheckDate(value: string): ParsedCheckDate | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (/^[+-]?\d+(?:\.\d+)?$/u.test(normalized)) {
    const numericValue = Number(normalized);
    if (!Number.isFinite(numericValue)) return null;
    return {
      timestamp:
        Math.abs(numericValue) < 10_000_000_000
          ? numericValue * 1000
          : numericValue,
      precision: 'instant',
    };
  }

  const dateOnlyMatch = DATE_ONLY_PATTERN.exec(normalized);
  if (dateOnlyMatch) {
    const [year, month, day] = dateOnlyMatch.slice(1).map(Number);
    return isValidDateTime(year, month, day, 0, 0, 0)
      ? {
          timestamp: Date.UTC(year, month - 1, day) - SHANGHAI_UTC_OFFSET_MS,
          precision: 'shanghai_day',
        }
      : null;
  }

  const isoMatch = ISO_WITH_TIMEZONE_PATTERN.exec(normalized);
  if (!isoMatch) return null;

  const year = Number(isoMatch[1]);
  const month = Number(isoMatch[2]);
  const day = Number(isoMatch[3]);
  const hour = Number(isoMatch[4]);
  const minute = Number(isoMatch[5]);
  const second = isoMatch[6] ? Number(isoMatch[6]) : 0;
  if (!isValidDateTime(year, month, day, hour, minute, second)) {
    return null;
  }
  if (isoMatch[8] !== 'Z') {
    const offsetHour = Number(isoMatch[10]);
    const offsetMinute = Number(isoMatch[11]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return null;
    }
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp)
    ? { timestamp, precision: 'instant' }
    : null;
}

function isRecordDateInsideEventWindow(
  recordDate: ParsedCheckDate,
  openedAtTimestamp: number,
): boolean {
  if (recordDate.precision === 'instant') {
    return recordDate.timestamp >= openedAtTimestamp;
  }

  return (
    getShanghaiDay(recordDate.timestamp) >= getShanghaiDay(openedAtTimestamp)
  );
}

function getShanghaiDay(timestamp: number): number {
  return Math.floor((timestamp + SHANGHAI_UTC_OFFSET_MS) / DAY_MS);
}

function isValidDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= lastDayOfMonth;
}

function getFieldText(value: unknown): string {
  return getFieldTexts(value).join('；');
}

function getFieldTexts(value: unknown, seen = new WeakSet<object>()): string[] {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    const text = normalizeText(String(value));
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return uniqueFieldTexts(value.flatMap((item) => getFieldTexts(item, seen)));
  }
  if (!isPlainRecord(value) || seen.has(value)) return [];

  seen.add(value);
  return uniqueFieldTexts(
    FIELD_WRAPPER_KEYS.flatMap((key) =>
      getFieldTexts(getOwnRecordValue(value, key), seen),
    ),
  );
}

function uniqueFieldTexts(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function getRecordList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getRecordIdentifier(record: unknown): string {
  return getFieldText(
    getOwnRecordValue(record, 'record_id') ?? getOwnRecordValue(record, 'id'),
  );
}

function getOwnRecordValue(record: unknown, key: string): unknown | undefined {
  if (!isPlainRecord(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptors(record)[key];
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function normalizeText(value: string): string {
  return value.trim();
}

function isWeatherGuardLevel(value: string): value is WeatherGuardLevel {
  return value === '一级戒备' || value === '二级戒备' || value === '三级戒备';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
