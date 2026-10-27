import { HttpService } from '@nestjs/axios';
import { Inject, Injectable } from '@nestjs/common';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  type FeishuBitableAuthConfig,
  extractDateValue,
  extractDisplayText,
  extractDisplayValues,
  fetchBitableRecords,
  getRecordId,
  normalizeBuildingLabel,
  normalizeShiftForFrontend,
  normalizeTeamForFrontend,
  pickField,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  fetchLeaveApprovalSnapshot,
  type ApprovedLeaveRequest,
  type LeaveApprovalSnapshot,
} from '../../common/feishu/leave-approval-source';
import { pickDutyStaffActualField } from '../duty-schedule/duty-staff-actual-field';
import {
  detectTodayOperationsScheduleConsistencyIssues,
  type TodayOperationsApprovedLeaveAssignmentSnapshot,
  type TodayOperationsScheduleConsistencyIssue,
  type TodayOperationsScheduleSnapshot,
} from './today-operations-schedule-consistency';

const DAY_MS = 24 * 60 * 60 * 1_000;
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_SCHEDULE_SYNC_GRACE_MS = 10 * 60_000;
const DEFAULT_SCHEDULE_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblRV9KeWFh9xCkm&view=vew6jLlGzq';
interface BuildConsistencySnapshotInput {
  businessDate: string;
  scheduleRecords: BitableRecordItem[];
  overtimeRecords?: BitableRecordItem[];
  leaveApproval: LeaveApprovalSnapshot;
  detectedAt?: string;
  syncGraceMs?: number;
}

@Injectable()
export class TodayOperationsScheduleConsistencyService {
  constructor(
    @Inject(HttpService)
    private readonly httpService: HttpService,
  ) {}

  async scan(
    businessDate: string,
  ): Promise<TodayOperationsScheduleConsistencyIssue[]> {
    const dateRange = resolveBusinessDateRange(businessDate);
    const auth = resolveTodayOperationsConsistencyAuth();
    const scheduleSource = await resolveSource(
      this.httpService,
      readEnv('TODAY_OPERATIONS_KPI_PERSONNEL_URL') ||
        DEFAULT_SCHEDULE_SOURCE_URL,
      '排班一致性巡检排班表',
      auth,
    );
    const [scheduleRecords, leaveApproval] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        ...scheduleSource,
        viewId: undefined,
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '排班日期',
              operator: 'isGreater',
              value: ['ExactDate', String(dateRange.lowerExclusive)],
            },
            {
              field_name: '排班日期',
              operator: 'isLess',
              value: ['ExactDate', String(dateRange.upperExclusive)],
            },
          ],
        },
        cacheTtlMs: SOURCE_CACHE_TTL_MS,
        forceRefresh: true,
        allowStale: false,
        strict: true,
        auth,
      }),
      fetchLeaveApprovalSnapshot(this.httpService, {
        forceRefresh: true,
        strict: true,
      }),
    ]);

    return buildTodayOperationsScheduleConsistencySnapshot({
      businessDate,
      scheduleRecords,
      leaveApproval,
      detectedAt: new Date().toISOString(),
      syncGraceMs: readScheduleSyncGraceMs(),
    });
  }
}

export function buildTodayOperationsScheduleConsistencySnapshot(
  input: BuildConsistencySnapshotInput,
): TodayOperationsScheduleConsistencyIssue[] {
  resolveBusinessDateRange(input.businessDate);
  const schedules = input.scheduleRecords
    .map(mapScheduleSnapshot)
    .filter((row): row is TodayOperationsScheduleSnapshot => Boolean(row))
    .filter((row) => isScheduleInScanWindow(row, input.businessDate));

  return detectTodayOperationsScheduleConsistencyIssues({
    schedules,
    approvedLeaveAssignments: buildApprovedLeaveAssignments(
      input.leaveApproval,
    ),
    detectedAt: input.detectedAt,
    syncGraceMs: input.syncGraceMs,
  });
}

function mapScheduleSnapshot(
  record: BitableRecordItem,
): TodayOperationsScheduleSnapshot | null {
  const fields = record.fields || {};
  const recordId = getRecordId(record);
  const scheduleDate = extractDateValue(
    pickField(fields, [
      'fldZSaDbGf',
      '排班日期',
      '日期',
      'schedule_date',
      '排班日期（日期）',
    ]),
  );
  const buildingText = extractDisplayText(
    pickField(fields, ['fldnP4gXMn', 'fldUHstSKX', '机楼', '楼栋', '值守机楼']),
  );
  const team = normalizeTeamForFrontend(
    extractDisplayText(pickField(fields, ['fldE9Gwnk7', '班组', '班别'])),
  );
  const normalizedShift = normalizeShiftForFrontend(
    extractDisplayText(pickField(fields, ['fldqPpOgW5', '班次', '值班班次'])),
  );
  const shift =
    normalizedShift === 'night'
      ? '夜班'
      : normalizedShift === 'white' ||
          normalizedShift === 'long_white' ||
          team === 'long_white'
        ? '白班'
        : '';
  const building = normalizeBuildingLabel(buildingText);
  if (!recordId || !scheduleDate || !building || !shift) return null;

  const window = resolveScheduleWindow(scheduleDate, building, shift);
  return {
    recordId,
    scheduleDate,
    building,
    shift,
    startAt: window.startAt,
    endAt: window.endAt,
    plannedStaff: extractStaffNames(
      pickField(fields, [
        'fldJi5bxBG',
        '人员（文本）',
        '人员文本',
        '人员',
        'flddMP5Au3',
        '值班人员（对照）',
      ]),
    ),
    actualStaff: extractStaffNames(pickDutyStaffActualField(fields)),
    approvedLeaveStaff: [],
    approvedSubstituteStaff: [],
  };
}

function buildApprovedLeaveAssignments(
  snapshot: LeaveApprovalSnapshot,
): TodayOperationsApprovedLeaveAssignmentSnapshot[] {
  if (!snapshot.verified) return [];
  return snapshot.requests.flatMap(buildRequestAssignments);
}

function buildRequestAssignments(
  request: ApprovedLeaveRequest,
): TodayOperationsApprovedLeaveAssignmentSnapshot[] {
  const bySchedule = new Map<
    string,
    {
      shiftKeys: Set<string>;
      substituteStaff: string[];
      effectiveAt: string | null;
    }
  >();
  const ensure = (scheduleRecordId: string) => {
    const recordId = scheduleRecordId.trim();
    if (!recordId) return null;
    const existing = bySchedule.get(recordId);
    if (existing) return existing;
    const created = {
      shiftKeys: new Set<string>(),
      substituteStaff: [] as string[],
      effectiveAt: latestDateTime(
        request.approvedAt,
        request.substituteAdjustedAt,
      ),
    };
    bySchedule.set(recordId, created);
    return created;
  };

  request.impactedScheduleRecordIds.forEach(ensure);
  if (request.shiftDetails !== undefined) {
    for (const detail of request.shiftDetails) {
      for (const scheduleRecordId of detail.scheduleRecordIds) {
        const assignment = ensure(scheduleRecordId);
        if (!assignment) continue;
        if (detail.shiftKey) assignment.shiftKeys.add(detail.shiftKey);
        assignment.substituteStaff.push(...detail.substituteStaff);
        assignment.effectiveAt = latestDateTime(
          assignment.effectiveAt,
          detail.updatedAt,
        );
      }
    }
  } else {
    const safeLegacySubstitutes =
      bySchedule.size === 1 || request.substituteStaff.length <= 1
        ? request.substituteStaff
        : [];
    for (const assignment of bySchedule.values()) {
      assignment.substituteStaff.push(...safeLegacySubstitutes);
    }
  }

  return Array.from(bySchedule.entries()).map(
    ([scheduleRecordId, assignment]) => ({
      sourceRecordId: request.recordId,
      scheduleRecordId,
      shiftKey: Array.from(assignment.shiftKeys).sort().join('、'),
      leaveStaff: dedupeStaffNames(request.leaveStaff),
      substituteStaff: dedupeStaffNames(assignment.substituteStaff),
      effectiveAt: assignment.effectiveAt,
    }),
  );
}

function resolveScheduleWindow(
  scheduleDate: string,
  building: string,
  shift: string,
): { startAt: string; endAt: string } {
  const station110 = /110/u.test(building);
  if (shift === '夜班') {
    const nextDate = formatShanghaiDate(
      Date.parse(`${scheduleDate}T00:00:00+08:00`) + DAY_MS,
    );
    return {
      startAt: `${scheduleDate}T${station110 ? '20:00' : '18:00'}:00+08:00`,
      endAt: `${nextDate}T${station110 ? '08:00' : '09:00'}:00+08:00`,
    };
  }
  return {
    startAt: `${scheduleDate}T${station110 ? '08:00' : '09:00'}:00+08:00`,
    endAt: `${scheduleDate}T${station110 ? '20:00' : '18:00'}:00+08:00`,
  };
}

function extractStaffNames(field: unknown): string[] {
  const values = extractDisplayValues(field)
    .flatMap((value) => value.split(/[\s、,，;；/]+/u))
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(
    new Map(values.map((value) => [normalizeName(value), value])).values(),
  );
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function resolveBusinessDateRange(businessDate: string): {
  lowerExclusive: number;
  upperExclusive: number;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) {
    throw new TypeError('排班一致性巡检业务日期无效');
  }
  const currentStart = Date.parse(`${businessDate}T00:00:00+08:00`);
  if (!Number.isFinite(currentStart)) {
    throw new TypeError('排班一致性巡检业务日期无效');
  }
  return {
    lowerExclusive: currentStart - 2 * DAY_MS,
    upperExclusive: currentStart + DAY_MS,
  };
}

function isScheduleInScanWindow(
  schedule: TodayOperationsScheduleSnapshot,
  businessDate: string,
): boolean {
  if (schedule.scheduleDate === businessDate) return true;
  const businessStart = Date.parse(`${businessDate}T00:00:00+08:00`);
  const previousDate = formatShanghaiDate(businessStart - DAY_MS);
  return (
    schedule.scheduleDate === previousDate &&
    schedule.shift === '夜班' &&
    Date.parse(schedule.endAt) > Date.parse(`${businessDate}T08:30:00+08:00`)
  );
}

function dedupeStaffNames(values: string[]): string[] {
  return Array.from(
    new Map(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => [normalizeName(value), value]),
    ).values(),
  );
}

function latestDateTime(
  ...values: Array<string | null | undefined>
): string | null {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite);
  return timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : null;
}

function readScheduleSyncGraceMs(): number {
  const raw = readEnv('TODAY_OPERATIONS_SCHEDULE_SYNC_GRACE_MS').trim();
  if (!raw) return DEFAULT_SCHEDULE_SYNC_GRACE_MS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0
    ? Math.min(configured, DAY_MS)
    : DEFAULT_SCHEDULE_SYNC_GRACE_MS;
}

function formatShanghaiDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}

async function resolveSource(
  httpService: HttpService,
  url: string,
  tableName: string,
  auth: FeishuBitableAuthConfig | undefined,
): Promise<{
  appToken: string;
  tableId: string;
  tableName: string;
  viewId?: string;
}> {
  const parsed = parseFeishuBitableLink(url);
  const appToken = await resolveBitableAppToken(httpService, {
    appToken: parsed.appToken,
    wikiToken: parsed.wikiToken,
    tableName,
    auth,
  });
  if (!appToken || !parsed.tableId) {
    throw new Error(`${tableName}数据源配置不完整`);
  }
  return {
    appToken,
    tableId: parsed.tableId,
    tableName,
    ...(parsed.viewId ? { viewId: parsed.viewId } : {}),
  };
}

function resolveTodayOperationsConsistencyAuth():
  | FeishuBitableAuthConfig
  | undefined {
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
