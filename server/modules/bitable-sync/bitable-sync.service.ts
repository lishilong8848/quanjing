import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { HttpService } from '@nestjs/axios';
import {
  appBitableSyncRecords,
  appSyncConfig,
  appSealingInfo,
  nantongOrganization,
  appEmployeeCertInfoFormal,
  holidayDutySchedule,
  nonDutySchedule,
  appFestivalImportantSchedule,
  appRoomScheduleEnhanced,
} from '@server/database/schema';
import {
  assertBitableTableConfig,
  getFeishuAuthPayload,
  maskSecret,
  readEnv,
} from '@server/common/config/external-services.config';
import { isDatabaseDisabled } from '@server/common/database/unavailable-database';
import {
  type BitableRecordItem,
  extractDateTimeIso,
  extractDateValue as extractFeishuDateValue,
  extractDisplayText,
  extractDisplayValues,
  extractNumberValue as extractFeishuNumberValue,
  fetchBitableRecords,
  getRecordId,
  invalidateBitableRecordCache,
  normalizeBuildingForFrontend,
  normalizeBuildingLabel,
  normalizeTeamForFrontend,
  pickField,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  warmLatestPersistedBitableRecordSnapshotIndex,
} from '@server/common/feishu/bitable-direct-read';
import {
  enrichScheduleRecordsWithLeaveApproval,
  fetchLeaveApprovalSnapshot,
  readCachedLeaveApprovalSnapshot,
  readCachedLeaveApprovalSnapshotState,
  SYSTEM_APPROVED_LEAVE_STAFF_FIELD,
  SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
  SYSTEM_APPROVED_POST_REPLACEMENTS_FIELD,
} from '@server/common/feishu/leave-approval-source';
import {
  inferActualSubstituteStaff,
  inferTemporarySubstituteStaff,
} from '@server/modules/duty-schedule/leave-substitute-audit';
import { resolveApprovalAwareDutyStaffFromFields } from '@server/modules/duty-schedule/approved-leave-visibility';
import { buildDutyProgramModifiedRefreshItem } from '@server/modules/duty-schedule/duty-program-modified-refresh';
import {
  DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES,
  pickDutyStaffActualField,
} from '@server/modules/duty-schedule/duty-staff-actual-field';
import { chunkBitableRecordUpdates } from '@server/modules/duty-schedule/bitable-record-update';
import {
  resolveWeatherWarningSourceStatus,
  type WeatherWarningFetchResult,
} from '@server/modules/weather-warning/weather-warning-source-status';
import { eq, desc, sql, and } from 'drizzle-orm';
import type {
  DutyStaff,
  DutyStaffByBuilding,
  FestivalSchedule,
  CampusOperationsBuildingMetric,
  CampusOperationsDashboardResponse,
  CampusOperationsTransformerRow,
  NantongOrganization,
  NonDutySchedule,
  PersonProfile,
  PersonProfileDetail,
  PersonProfileDetailResponse,
  PersonProfileResponse,
  ScheduleSnapshotRevisionResponse,
  TodayLeaveStaffResponse,
} from '@shared/api.interface';
import type {
  OrganizationPersonProfileResponse,
  OrganizationPersonProfileSource,
} from '@shared/organization-person-profile';
import { resolvePreviousCampusOperationsShift } from '@shared/campus-operations-shift';
import type { LeaveRequestImpactSchedule } from '@shared/leave-request-impact';
import {
  DEFAULT_LEAVE_PERSON_PROFILE_TABLE_ID,
  DEFAULT_LEAVE_PERSON_PROFILE_WIKI_TOKEN,
  type PersonProfilePhotoScope,
  type PersonProfileScope,
  resolvePersonProfileDetailReadPlan,
  resolvePersonProfileReadPlan,
} from './person-profile-source';
import { listEligibleChangeRequestSubmitterNames } from './change-request-submitter-directory';
import {
  buildActivePersonnelDirectory,
  DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
  DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
  type ActivePersonnelDirectory,
} from './active-personnel-directory';
import {
  buildFeishuChatAppLink,
  extractFeishuOpenId,
} from './person-profile-contact';
import {
  buildOrganizationPersonQualityAssessment,
  mapOrganizationPersonProfileRecord,
} from './organization-person-profile.mapper';

const ALI_MONTHLY_QUALITY_ISSUE_TABLE_ID = 'tbl2ukkCV1Fjh149';
const ALI_MONTHLY_QUALITY_ISSUE_VIEW_ID = 'vewPxuzNcN';

interface OpenMeteoForecastResponse {
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    relative_humidity_2m?: number[];
    weather_code?: number[];
    wind_speed_10m?: number[];
    wind_direction_10m?: number[];
  };
}

interface ChinaWeatherForecastItem {
  ymd?: string;
  high?: string;
  low?: string;
  fx?: string;
  fl?: string;
  type?: string;
}

interface ChinaWeatherResponse {
  status?: number;
  time?: string;
  cityInfo?: {
    city?: string;
    updateTime?: string;
  };
  data?: {
    shidu?: string;
    wendu?: string | number;
    quality?: string;
    forecast?: ChinaWeatherForecastItem[];
  };
}

export interface QWeatherWarningItem {
  id?: string;
  sender?: string;
  pubTime?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
  level?: string;
  severityColor?: string;
  severity?: string;
  type?: string;
  typeName?: string;
  text?: string;
}

export interface QWeatherWarningResponse {
  code: string;
  updateTime?: string;
  fxLink?: string;
  warning?: QWeatherWarningItem[];
  refer?: unknown;
}

export interface ApprovedLeaveScheduleSyncAssignment {
  shiftKey: string;
  scheduleRecordIds: string[];
  substituteName: string;
  originalPostBackfills?: import('../../../shared/leave-original-post-backfill').LeaveOriginalPostBackfill[];
}

export interface ApprovedLeaveScheduleSyncScope {
  applicantName: string;
  startAt: string;
  endAt: string;
  substituteName?: string;
  releasedOriginalPosts?: Array<{ scheduleRecordIds: string[]; previousPrimaryName: string; previousBackupName: string }>;
}

interface CachedEmployeePhoto {
  contentType: string;
  buffer: Buffer;
  expiresAt: number;
}

interface TodayTemporarySubstituteGroup {
  shift: string;
  shiftLabel: string;
  staff: Set<string>;
}

interface TodayLeaveBuildingData {
  leaveStaff: Set<string>;
  substituteStaff: Set<string>;
  temporarySubstituteStaff: Set<string>;
  temporarySubstitutesByShift: Map<string, TodayTemporarySubstituteGroup>;
}

interface CampusOperationsTargetShift {
  requestedDate: string;
  requestedShift: string;
  rule: string;
}

interface CampusOperationsTransformerCandidate extends CampusOperationsTransformerRow {
  date: string;
  shift: string;
}

interface CampusOperationsBuildingCandidate extends CampusOperationsBuildingMetric {
  date: string;
  shift: string;
}

interface CampusOperationsRecordGroup<T> {
  date: string;
  shift: string;
  rows: T[];
}

@Injectable()
export class BitableSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BitableSyncService.name);
  private readonly employeePhotoCache = new Map<string, CachedEmployeePhoto>();
  private isSyncing = false;
  private cacheRefreshTimer?: NodeJS.Timeout;
  private leaveApprovalRefreshTimer?: NodeJS.Timeout;
  private cacheRefreshRunning = false;
  private leaveApprovalRefreshRunning = false;
  // 飞书多维表配置 - 封网信息表
  private readonly APP_TOKEN = readEnv('FEISHU_SEALING_APP_TOKEN', [
    'FEISHU_MAIN_APP_TOKEN',
    'FEISHU_BITABLE_APP_TOKEN',
  ]);
  private readonly TABLE_ID = readEnv('FEISHU_SEALING_TABLE_ID');
  private readonly SEALING_VIEW_ID = readEnv('FEISHU_SEALING_VIEW_ID');

  // 飞书多维表配置 - 组织架构/在职人员表
  private readonly ORG_APP_TOKEN = readEnv('FEISHU_ORG_APP_TOKEN', [
    'FEISHU_ORGANIZATION_APP_TOKEN',
  ]);
  private readonly ORG_TABLE_ID =
    readEnv('FEISHU_ORG_TABLE_ID', ['FEISHU_ORGANIZATION_TABLE_ID']) ||
    DEFAULT_ACTIVE_PERSONNEL_TABLE_ID;
  private readonly ORG_VIEW_ID =
    readEnv('FEISHU_ORG_VIEW_ID', ['FEISHU_ORGANIZATION_VIEW_ID']) ||
    DEFAULT_ACTIVE_PERSONNEL_VIEW_ID;
  private readonly ORG_PROFILE_VIEW_ID =
    readEnv('FEISHU_ORG_PROFILE_VIEW_ID', [
      'FEISHU_ORGANIZATION_PROFILE_VIEW_ID',
    ]) || 'vewzzrEb27';
  private readonly LEAVE_PERSON_PROFILE_APP_TOKEN = readEnv(
    'FEISHU_LEAVE_PERSON_PROFILE_APP_TOKEN',
    ['FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN', 'FEISHU_LEAVE_REQUEST_APP_TOKEN'],
  );
  private readonly LEAVE_PERSON_PROFILE_WIKI_TOKEN =
    readEnv('FEISHU_LEAVE_PERSON_PROFILE_WIKI_TOKEN', [
      'FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN',
      'FEISHU_LEAVE_REQUEST_WIKI_TOKEN',
    ]) || DEFAULT_LEAVE_PERSON_PROFILE_WIKI_TOKEN;
  private readonly LEAVE_PERSON_PROFILE_TABLE_ID =
    readEnv('FEISHU_LEAVE_PERSON_PROFILE_TABLE_ID') ||
    DEFAULT_LEAVE_PERSON_PROFILE_TABLE_ID;
  private readonly TRAVEL_PERSON_PROFILE_VIEW_ID =
    readEnv('FEISHU_TRAVEL_PERSON_PROFILE_VIEW_ID', [
      'FEISHU_PERSONNEL_MOVEMENT_VIEW_ID',
    ]) || 'vewrQcypV4';

  // 飞书多维表配置 - 员工证书信息表
  private readonly CERT_APP_TOKEN = readEnv('FEISHU_CERT_APP_TOKEN');
  private readonly CERT_TABLE_ID = readEnv('FEISHU_CERT_TABLE_ID');

  // 飞书多维表配置 - 节日&重保排班表
  private readonly HOLIDAY_APP_TOKEN = readEnv('FEISHU_HOLIDAY_APP_TOKEN', [
    'FEISHU_MAIN_APP_TOKEN',
    'FEISHU_BITABLE_APP_TOKEN',
  ]);
  private readonly HOLIDAY_TABLE_ID = readEnv('FEISHU_HOLIDAY_TABLE_ID');
  private readonly FESTIVAL_IMPORTANT_APP_TOKEN = readEnv(
    'FEISHU_FESTIVAL_IMPORTANT_APP_TOKEN',
    [
      'FEISHU_FESTIVAL_APP_TOKEN',
      'FEISHU_MAIN_APP_TOKEN',
      'FEISHU_BITABLE_APP_TOKEN',
    ],
  );
  private readonly FESTIVAL_IMPORTANT_TABLE_ID =
    readEnv('FEISHU_FESTIVAL_IMPORTANT_TABLE_ID', [
      'FEISHU_FESTIVAL_TABLE_ID',
    ]) || 'tblS3x6aazHbvAck';
  private readonly FESTIVAL_IMPORTANT_VIEW_ID =
    readEnv('FEISHU_FESTIVAL_IMPORTANT_VIEW_ID', ['FEISHU_FESTIVAL_VIEW_ID']) ||
    'vewgzik2Nv';

  // 飞书多维表配置 - 非值班排班表
  private readonly NON_DUTY_APP_TOKEN = readEnv('FEISHU_NON_DUTY_APP_TOKEN', [
    'FEISHU_MAIN_APP_TOKEN',
    'FEISHU_BITABLE_APP_TOKEN',
  ]);
  private readonly NON_DUTY_TABLE_ID = readEnv('FEISHU_NON_DUTY_TABLE_ID');

  // 飞书多维表配置 - 值班排班表（用于无数据库模式下合并请休假信息）
  private readonly SCHEDULE_APP_TOKEN = readEnv('FEISHU_SCHEDULE_APP_TOKEN', [
    'FEISHU_DUTY_APP_TOKEN',
    'FEISHU_MAIN_APP_TOKEN',
    'FEISHU_BITABLE_APP_TOKEN',
  ]);
  private readonly SCHEDULE_TABLE_ID = readEnv('FEISHU_SCHEDULE_TABLE_ID', [
    'FEISHU_DUTY_TABLE_ID',
  ]);

  private readonly CAMPUS_OPS_APP_TOKEN =
    readEnv('FEISHU_CAMPUS_OPS_APP_TOKEN') || 'ASLxbfESPahdTKs0A9NccgbrnXc';
  private readonly CAMPUS_OPS_TRANSFORMER_TABLE_ID =
    readEnv('FEISHU_CAMPUS_OPS_TRANSFORMER_TABLE_ID') || 'tbl8Ni54taYGeWAa';
  private readonly CAMPUS_OPS_TRANSFORMER_VIEW_ID =
    readEnv('FEISHU_CAMPUS_OPS_TRANSFORMER_VIEW_ID') || 'vewVqB5Mps';
  private readonly CAMPUS_OPS_MACHINE_TABLE_ID =
    readEnv('FEISHU_CAMPUS_OPS_MACHINE_TABLE_ID') || 'tblz8rjxdtRRlYmS';
  private readonly CAMPUS_OPS_MACHINE_VIEW_ID =
    readEnv('FEISHU_CAMPUS_OPS_MACHINE_VIEW_ID') || 'vewP1zyEKp';
  private readonly CAMPUS_OPS_CACHE_TTL_MS =
    this.getPositiveNumberEnv('FEISHU_CAMPUS_OPS_CACHE_TTL_MS') ??
    4 * 60 * 60 * 1000;
  private readonly CAMPUS_OPS_NIGHT_SHIFT_START_HOUR =
    this.getPositiveNumberEnv('CAMPUS_OPS_NIGHT_SHIFT_START_HOUR') ?? 20;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly httpService: HttpService,
  ) {}

  async getScheduleSnapshotRevision(): Promise<ScheduleSnapshotRevisionResponse> {
    const [nonDutySnapshot, scheduleSnapshot, leaveApprovalState] =
      await Promise.all([
        readLatestPersistedBitableRecordSnapshot({
          appToken: this.NON_DUTY_APP_TOKEN || undefined,
          tableId: this.NON_DUTY_TABLE_ID,
          tableName: '长白班排班',
        }),
        readLatestPersistedBitableRecordSnapshot({
          appToken: this.SCHEDULE_APP_TOKEN || undefined,
          tableId: this.SCHEDULE_TABLE_ID,
          tableName: '值班排班',
        }),
        readCachedLeaveApprovalSnapshotState(),
      ]);
    const nonDutyFetchedAt = nonDutySnapshot?.fetchedAt ?? null;
    const scheduleFetchedAt = scheduleSnapshot?.fetchedAt ?? null;
    const available = nonDutySnapshot !== null && scheduleSnapshot !== null;

    return {
      available,
      token: available
        ? `${nonDutyFetchedAt}:${scheduleFetchedAt}:${leaveApprovalState.approvalFetchedAt ?? 0}:${leaveApprovalState.shiftDetailFetchedAt ?? 0}`
        : null,
      nonDutyFetchedAt,
      scheduleFetchedAt,
    };
  }

  async onModuleInit(): Promise<void> {
    if (
      /^(?:1|true|on|yes)$/i.test(
        process.env.NANTONG_HOTFIX_SMOKE_MODE?.trim() || '',
      )
    ) {
      return;
    }
    if (this.cacheRefreshTimer || this.leaveApprovalRefreshTimer) {
      return;
    }
    await warmLatestPersistedBitableRecordSnapshotIndex();
    await this.warmLeaveFormLocalSnapshots();
    void this.refreshFeishuLocalCache();
    this.cacheRefreshTimer = setInterval(
      () => void this.refreshFeishuLocalCache(),
      this.getLocalCacheRefreshMs(),
    );
    this.cacheRefreshTimer.unref?.();
    this.leaveApprovalRefreshTimer = setInterval(
      () => void this.refreshLeaveApprovalCache(),
      this.getLeaveApprovalRefreshMs(),
    );
    this.leaveApprovalRefreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cacheRefreshTimer) {
      clearInterval(this.cacheRefreshTimer);
      this.cacheRefreshTimer = undefined;
    }
    if (this.leaveApprovalRefreshTimer) {
      clearInterval(this.leaveApprovalRefreshTimer);
      this.leaveApprovalRefreshTimer = undefined;
    }
  }

  private getPositiveNumberEnv(name: string): number | null {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private getLocalCacheRefreshMs(): number {
    const parsed = Number(process.env.FEISHU_LOCAL_CACHE_REFRESH_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 4 * 60 * 60 * 1000;
  }

  private getLeaveApprovalRefreshMs(): number {
    const parsed = Number(process.env.FEISHU_LEAVE_APPROVAL_REFRESH_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000;
  }

  private async warmLeaveFormLocalSnapshots(): Promise<void> {
    await Promise.allSettled([
      readLatestPersistedBitableRecordSnapshot({
        appToken: this.SCHEDULE_APP_TOKEN || undefined,
        tableId: this.SCHEDULE_TABLE_ID,
        tableName: '值班排班',
      }),
      this.readCachedPersonProfileRecords('leave', false),
      this.readCachedPersonProfileRecords('leave', true),
      readCachedLeaveApprovalSnapshot(),
    ]);
  }

  private async refreshLeaveApprovalCache(): Promise<void> {
    if (this.leaveApprovalRefreshRunning) {
      return;
    }
    this.leaveApprovalRefreshRunning = true;
    try {
      const snapshot = await fetchLeaveApprovalSnapshot(this.httpService, {
        forceRefresh: true,
        strict: true,
      });
      this.logger.log(
        `Feishu leave approval cache refreshed: ${snapshot.requests.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Feishu leave approval cache refresh failed: ${message}`,
      );
    } finally {
      this.leaveApprovalRefreshRunning = false;
    }
  }

  private async refreshFeishuLocalCache(): Promise<void> {
    if (this.cacheRefreshRunning) {
      return;
    }
    this.cacheRefreshRunning = true;
    const refreshTasks: Array<{
      name: string;
      run: () => Promise<BitableRecordItem[]>;
    }> = [
      { name: 'non-duty', run: () => this.fetchFeishuNonDutyRecords(true) },
      { name: 'schedule', run: () => this.fetchFeishuScheduleRecords(true) },
      {
        name: 'festival-important',
        run: () => this.fetchFeishuFestivalImportantRecords(true),
      },
    ];

    if (this.ORG_APP_TOKEN && this.ORG_TABLE_ID) {
      refreshTasks.push({
        name: 'organization',
        run: () => this.fetchFeishuOrganizationRecords(true),
      });
    }
    refreshTasks.push({
      name: 'person-profile',
      run: () => this.fetchFeishuPersonProfileRecords(true, 'leave'),
    });
    refreshTasks.push({
      name: 'person-profile-details',
      run: () => this.fetchFeishuPersonProfileRecords(true, 'leave', true),
    });

    try {
      const results = await Promise.allSettled(
        refreshTasks.map((task) => task.run()),
      );
      const summary: string[] = [];

      results.forEach((result, index) => {
        const taskName = refreshTasks[index].name;
        if (result.status === 'fulfilled') {
          summary.push(`${taskName} ${result.value.length}`);
        } else {
          const message =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          this.logger.warn(
            `Feishu local cache refresh failed for ${taskName}: ${message}`,
          );
        }
      });

      if (summary.length > 0) {
        this.logger.log(`Feishu local cache refreshed: ${summary.join(', ')}`);
      }
    } finally {
      this.cacheRefreshRunning = false;
    }
  }

  private async fetchFeishuNonDutyRecords(
    forceRefresh = false,
    strict = false,
  ): Promise<BitableRecordItem[]> {
    const [records, approvalSnapshot] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken: this.NON_DUTY_APP_TOKEN,
        tableId: this.NON_DUTY_TABLE_ID,
        tableName: '长白班排班',
        forceRefresh,
        allowStale: !strict,
        strict,
      }),
      fetchLeaveApprovalSnapshot(this.httpService, {
        forceRefresh,
        strict,
      }),
    ]);
    return enrichScheduleRecordsWithLeaveApproval(records, approvalSnapshot);
  }

  private async fetchFeishuScheduleRecords(
    forceRefresh = false,
    strict = false,
  ): Promise<BitableRecordItem[]> {
    const [records, approvalSnapshot] = await Promise.all([
      fetchBitableRecords(this.httpService, {
        appToken: this.SCHEDULE_APP_TOKEN,
        tableId: this.SCHEDULE_TABLE_ID,
        tableName: '值班排班',
        forceRefresh,
        allowStale: !strict,
        strict,
      }),
      fetchLeaveApprovalSnapshot(this.httpService, {
        forceRefresh,
        strict,
      }),
    ]);
    return enrichScheduleRecordsWithLeaveApproval(records, approvalSnapshot);
  }

  private async fetchFeishuFestivalImportantRecords(
    forceRefresh = false,
  ): Promise<BitableRecordItem[]> {
    return fetchBitableRecords(this.httpService, {
      appToken: this.FESTIVAL_IMPORTANT_APP_TOKEN,
      tableId: this.FESTIVAL_IMPORTANT_TABLE_ID,
      viewId: this.FESTIVAL_IMPORTANT_VIEW_ID || undefined,
      tableName: 'festival-important-duty',
      forceRefresh,
    });
  }

  private async fetchCampusOpsTransformerRecords(
    forceRefresh = false,
  ): Promise<BitableRecordItem[]> {
    return fetchBitableRecords(this.httpService, {
      appToken: this.CAMPUS_OPS_APP_TOKEN,
      tableId: this.CAMPUS_OPS_TRANSFORMER_TABLE_ID,
      viewId: this.CAMPUS_OPS_TRANSFORMER_VIEW_ID || undefined,
      tableName: 'campus-ops-transformer',
      cacheTtlMs: this.CAMPUS_OPS_CACHE_TTL_MS,
      forceRefresh,
    });
  }

  private async fetchCampusOpsMachineRecords(
    forceRefresh = false,
  ): Promise<BitableRecordItem[]> {
    return fetchBitableRecords(this.httpService, {
      appToken: this.CAMPUS_OPS_APP_TOKEN,
      tableId: this.CAMPUS_OPS_MACHINE_TABLE_ID,
      viewId: this.CAMPUS_OPS_MACHINE_VIEW_ID || undefined,
      tableName: 'campus-ops-machine',
      cacheTtlMs: this.CAMPUS_OPS_CACHE_TTL_MS,
      forceRefresh,
    });
  }

  async getCampusOperationsDashboard(
    forceRefresh = false,
    screenshotDate?: string,
    screenshotShift?: string,
  ): Promise<CampusOperationsDashboardResponse> {
    const strictScreenshotRequest = this.isCampusOperationsScreenshotRequest(
      screenshotDate,
      screenshotShift,
    );
    const target = this.getCampusOperationsTargetShift(
      new Date(),
      screenshotDate,
      screenshotShift,
    );
    const [transformerRecords, machineRecords] = await Promise.all([
      this.fetchCampusOpsTransformerRecords(forceRefresh),
      this.fetchCampusOpsMachineRecords(forceRefresh),
    ]);

    const transformerCandidates = transformerRecords
      .map((record) => this.mapCampusOpsTransformerRecord(record))
      .filter((row): row is CampusOperationsTransformerCandidate =>
        Boolean(row),
      );
    const machineCandidates = machineRecords
      .map((record) => this.mapCampusOpsMachineRecord(record))
      .filter((row): row is CampusOperationsBuildingCandidate => Boolean(row));

    const expectedTransformerNames = [
      '1号主变',
      '2号主变',
      '3号主变',
      '4号主变',
    ];
    const expectedMachineBuildings = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];
    const transformerGroup = this.selectCampusOperationsGroup(
      transformerCandidates,
      target,
      expectedTransformerNames,
      (row) => row.name,
      strictScreenshotRequest,
    );
    const machineGroup = this.selectCampusOperationsGroup(
      machineCandidates,
      target,
      expectedMachineBuildings,
      (row) => row.building,
      strictScreenshotRequest,
    );

    if (strictScreenshotRequest && (!transformerGroup || !machineGroup)) {
      const missingSources: string[] = [];
      if (!transformerGroup) {
        const missingTransformers = this.getMissingCampusOperationsKeys(
          transformerCandidates,
          target,
          expectedTransformerNames,
          (row) => row.name,
        );
        missingSources.push(`主变缺少：${missingTransformers.join('、')}`);
      }
      if (!machineGroup) {
        const missingBuildings = this.getMissingCampusOperationsKeys(
          machineCandidates,
          target,
          expectedMachineBuildings,
          (row) => row.building,
        );
        missingSources.push(`机房缺少：${missingBuildings.join('、')}`);
      }
      throw new ServiceUnavailableException(
        `园区运行截图数据未就绪：${target.requestedDate} ${target.requestedShift}（${missingSources.join('；')}）`,
      );
    }

    const transformerRows = (transformerGroup?.rows || [])
      .slice()
      .sort(
        (a, b) =>
          this.getCampusTransformerOrder(a.name) -
          this.getCampusTransformerOrder(b.name),
      )
      .map(({ date: _date, shift: _shift, ...row }) => row);
    const buildingMetrics = (machineGroup?.rows || [])
      .slice()
      .sort(
        (a, b) =>
          this.getCampusBuildingOrder(a.building) -
          this.getCampusBuildingOrder(b.building),
      )
      .map(({ date: _date, shift: _shift, ...row }) => row);

    return {
      transformerRows,
      buildingMetrics,
      target: {
        requestedDate: target.requestedDate,
        requestedShift: target.requestedShift,
        transformerDate: transformerGroup?.date || null,
        transformerShift: transformerGroup?.shift || null,
        machineDate: machineGroup?.date || null,
        machineShift: machineGroup?.shift || null,
        rule: target.rule,
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  private mapCampusOpsTransformerRecord(
    record: BitableRecordItem,
  ): CampusOperationsTransformerCandidate | null {
    const fields = record.fields || {};
    const date = extractFeishuDateValue(
      pickField(fields, ['fld4I1eGuk', '日期']),
    );
    const shift = this.normalizeCampusShift(
      extractDisplayText(pickField(fields, ['fldy7mPOFN', '班次'])),
    );
    const name = this.normalizeTransformerName(
      extractDisplayText(pickField(fields, ['fldyYxxkz8', '主变名称'])),
    );

    if (!date || !shift || !name) {
      return null;
    }

    const oilTemp =
      this.extractCampusNumber(pickField(fields, ['fldQdHk9by', '油温'])) ?? 0;
    const gear =
      this.extractCampusNumber(pickField(fields, ['fldsgz0Mkx', '档位'])) ?? 0;
    const load =
      this.extractCampusNumber(
        pickField(fields, ['fldvNDJSbE', '负载（KW）']),
      ) ?? 0;
    const current = this.extractCampusNumber(
      pickField(fields, ['fldhmRBLS8', '电流（A）']),
    );
    const loadRate = this.extractCampusPercent(
      pickField(fields, ['fldl1bcK5X', '负载率%']),
    );

    return {
      date,
      shift,
      name,
      line:
        extractDisplayText(pickField(fields, ['fld3ljLHbM', '所属线路'])) || '',
      oilTemp: Math.round(oilTemp),
      gear: Math.round(gear),
      load: Math.round(load),
      current: current === null ? '' : this.formatCompactDecimal(current, 2),
      loadRate: this.formatPercent(loadRate),
      status:
        extractDisplayText(
          pickField(fields, ['fld62HUTLe', 'GIS压力是否正常']),
        ) || '正常',
    };
  }

  private mapCampusOpsMachineRecord(
    record: BitableRecordItem,
  ): CampusOperationsBuildingCandidate | null {
    const fields = record.fields || {};
    const date = extractFeishuDateValue(
      pickField(fields, ['fldkCWHqlj', '日期']),
    );
    const shift = this.normalizeCampusShift(
      extractDisplayText(pickField(fields, ['fldaeIqflp', '班次'])),
    );
    const building = this.normalizeCampusBuilding(
      extractDisplayText(pickField(fields, ['fld6CearKq', '楼栋'])),
    );

    if (!date || !shift || !building) {
      return null;
    }

    const totalPower =
      this.extractCampusNumber(
        pickField(fields, ['fld51wUtOQ', '总负荷（kW）']),
      ) ?? 0;
    const itPower =
      this.extractCampusNumber(
        pickField(fields, ['fldqJXxtV9', 'IT总负荷（kW）']),
      ) ?? 0;
    const itDesignPower =
      this.extractCampusNumber(
        pickField(fields, [
          'fldLbOiqjL',
          'IT设计总负荷（kW）',
          'IT设计总负荷（KW）',
        ]),
      ) ?? 0;
    const pue =
      this.extractCampusNumber(
        pickField(fields, ['fldnl9HLGK', 'PUE（实时）']),
      ) ?? 0;
    const explicitItLoad = this.extractCampusPercent(
      pickField(fields, ['fld7tu7aNK', 'IT负载率', 'IT负载率%']),
    );
    const itLoad = explicitItLoad ?? 0;

    return {
      date,
      shift,
      building,
      totalPower: Math.round(totalPower),
      pue,
      itPower: Math.round(itPower),
      itDesignPower: Math.round(itDesignPower),
      itLoad,
    };
  }

  private getCampusOperationsTargetShift(
    now = new Date(),
    screenshotDate?: string,
    screenshotShift?: string,
  ): CampusOperationsTargetShift {
    const normalizedScreenshotDate = String(screenshotDate || '').trim();
    const normalizedScreenshotShift = String(screenshotShift || '')
      .trim()
      .toLowerCase();
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(normalizedScreenshotDate) &&
      (normalizedScreenshotShift === 'white' ||
        normalizedScreenshotShift === 'night')
    ) {
      const previousShift = resolvePreviousCampusOperationsShift(
        normalizedScreenshotDate,
        normalizedScreenshotShift,
      );
      if (!previousShift) {
        throw new Error(`无效的日报截图日期：${normalizedScreenshotDate}`);
      }
      return {
        requestedDate: previousShift.date,
        requestedShift: previousShift.shiftLabel,
        rule: `按签名截图请求对应日报班次的上一班次取数（日报 ${normalizedScreenshotDate} ${normalizedScreenshotShift === 'white' ? '白班' : '夜班'}）`,
      };
    }

    const { dateKey, hour } = this.getShanghaiDateKeyAndHour(now);
    const nightStartHour = Math.max(
      0,
      Math.min(23, Math.floor(this.CAMPUS_OPS_NIGHT_SHIFT_START_HOUR)),
    );

    if (hour >= nightStartHour) {
      return {
        requestedDate: dateKey,
        requestedShift: '白班',
        rule: `上海时间${nightStartHour}:00后取当日白班`,
      };
    }

    return {
      requestedDate: this.addDaysToDateKey(dateKey, -1),
      requestedShift: '夜班',
      rule: `上海时间${nightStartHour}:00前取前一日夜班`,
    };
  }

  private isCampusOperationsScreenshotRequest(
    screenshotDate?: string,
    screenshotShift?: string,
  ): boolean {
    const normalizedDate = String(screenshotDate || '').trim();
    const normalizedShift = String(screenshotShift || '')
      .trim()
      .toLowerCase();
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(normalizedDate) &&
      (normalizedShift === 'white' || normalizedShift === 'night')
    );
  }

  private getShanghaiDateKeyAndHour(date: Date): {
    dateKey: string;
    hour: number;
  } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const map = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const hour = Number(map.hour === '24' ? '0' : map.hour);
    return {
      dateKey: `${map.year}-${map.month}-${map.day}`,
      hour: Number.isFinite(hour) ? hour : 0,
    };
  }

  private addDaysToDateKey(dateKey: string, days: number): string {
    const [year, month, day] = dateKey.split('-').map((part) => Number(part));
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
  }

  private selectCampusOperationsGroup<
    T extends { date: string; shift: string },
  >(
    rows: T[],
    target: CampusOperationsTargetShift,
    expectedKeys: string[],
    getKey: (row: T) => string,
    exactOnly = false,
  ): CampusOperationsRecordGroup<T> | null {
    const groupMap = new Map<string, CampusOperationsRecordGroup<T>>();
    for (const row of rows) {
      const key = `${row.date}|${row.shift}`;
      const existing = groupMap.get(key);
      if (existing) {
        existing.rows.push(row);
      } else {
        groupMap.set(key, { date: row.date, shift: row.shift, rows: [row] });
      }
    }

    const groups = Array.from(groupMap.values());
    if (groups.length === 0) {
      return null;
    }

    const targetKey = `${target.requestedDate}|${target.requestedShift}`;
    const exactGroup = groups.find(
      (group) => `${group.date}|${group.shift}` === targetKey,
    );
    if (
      exactGroup &&
      this.isCampusOperationsGroupComplete(exactGroup, expectedKeys, getKey)
    ) {
      return exactGroup;
    }
    if (exactOnly) {
      return null;
    }

    const targetSortValue = this.getCampusOperationsGroupSortValue(
      target.requestedDate,
      target.requestedShift,
    );
    const completeGroupsBeforeTarget = groups
      .filter((group) =>
        this.isCampusOperationsGroupComplete(group, expectedKeys, getKey),
      )
      .filter(
        (group) =>
          this.getCampusOperationsGroupSortValue(group.date, group.shift) <=
          targetSortValue,
      )
      .sort(
        (a, b) =>
          this.getCampusOperationsGroupSortValue(b.date, b.shift) -
          this.getCampusOperationsGroupSortValue(a.date, a.shift),
      );
    if (completeGroupsBeforeTarget.length > 0) {
      return completeGroupsBeforeTarget[0];
    }

    if (exactGroup) {
      return exactGroup;
    }

    return groups.sort(
      (a, b) =>
        this.getCampusOperationsGroupSortValue(b.date, b.shift) -
        this.getCampusOperationsGroupSortValue(a.date, a.shift),
    )[0];
  }

  private isCampusOperationsGroupComplete<T>(
    group: CampusOperationsRecordGroup<T>,
    expectedKeys: string[],
    getKey: (row: T) => string,
  ): boolean {
    const keys = new Set(group.rows.map(getKey));
    return expectedKeys.every((key) => keys.has(key));
  }

  private getMissingCampusOperationsKeys<
    T extends { date: string; shift: string },
  >(
    rows: T[],
    target: CampusOperationsTargetShift,
    expectedKeys: string[],
    getKey: (row: T) => string,
  ): string[] {
    const presentKeys = new Set(
      rows
        .filter(
          (row) =>
            row.date === target.requestedDate &&
            row.shift === target.requestedShift,
        )
        .map(getKey),
    );
    return expectedKeys.filter((key) => !presentKeys.has(key));
  }

  private getCampusOperationsGroupSortValue(
    date: string,
    shift: string,
  ): number {
    return Number(date.replace(/-/g, '')) * 10 + (shift === '夜班' ? 2 : 1);
  }

  private normalizeCampusShift(value: string): string {
    const text = value.trim();
    if (text.includes('夜') || text.toLowerCase().includes('night')) {
      return '夜班';
    }
    if (text.includes('白') || text.toLowerCase().includes('day')) {
      return '白班';
    }
    return text;
  }

  private normalizeTransformerName(value: string): string {
    const match = value.match(/[1-4]/);
    return match ? `${match[0]}号主变` : value.trim();
  }

  private normalizeCampusBuilding(value: string): string {
    const text = value.trim().toUpperCase();
    const match = text.match(/[A-E]/);
    return match ? `${match[0]}楼` : value.trim();
  }

  private getCampusTransformerOrder(name: string): number {
    return Number(name.match(/\d+/)?.[0] || 99);
  }

  private getCampusBuildingOrder(building: string): number {
    const order = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].indexOf(building);
    return order === -1 ? 99 : order;
  }

  private extractCampusNumber(field: unknown): number | null {
    const numeric = extractFeishuNumberValue(field);
    if (numeric !== null) {
      return numeric;
    }

    const text = extractDisplayText(field, '').replace(/,/g, '');
    const match = text.match(/-?\d+(?:\.\d+)?/);
    if (!match) {
      return null;
    }

    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private extractCampusPercent(field: unknown): number | null {
    const text = extractDisplayText(field, '').replace(/,/g, '').trim();
    const numeric = this.extractCampusNumber(field);
    if (numeric === null) {
      return null;
    }
    if (text.includes('%')) {
      return numeric;
    }
    return numeric <= 1 ? numeric * 100 : numeric;
  }

  private formatPercent(value: number | null): string {
    return `${(value ?? 0).toFixed(2)}%`;
  }

  private formatCompactDecimal(value: number, maxPrecision: number): string {
    return value.toLocaleString('en-US', {
      useGrouping: false,
      minimumFractionDigits: 0,
      maximumFractionDigits: maxPrecision,
    });
  }

  private async getFestivalSchedulesFromFeishu(
    params: { startDate?: string; endDate?: string } = {},
  ): Promise<{ schedules: FestivalSchedule[] }> {
    const records = await this.fetchFeishuFestivalImportantRecords();
    const schedules = records
      .map((record) => this.mapFeishuFestivalImportantRecord(record))
      .filter((schedule): schedule is FestivalSchedule => {
        if (!schedule) return false;
        if (
          params.startDate &&
          (!schedule.appScheduleDate ||
            schedule.appScheduleDate < params.startDate)
        )
          return false;
        if (
          params.endDate &&
          (!schedule.appScheduleDate ||
            schedule.appScheduleDate > params.endDate)
        )
          return false;
        return true;
      })
      .sort((a, b) =>
        (a.appScheduleDate || '').localeCompare(b.appScheduleDate || ''),
      );

    this.logger.log(
      `Feishu direct festival-important duty: ${schedules.length} records`,
    );
    return { schedules };
  }

  private mapFeishuFestivalImportantRecord(
    record: BitableRecordItem,
  ): FestivalSchedule | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const appScheduleDate = extractFeishuDateValue(
      pickField(fields, ['fldLrsdEpv', '排班日期', '日期']),
    );
    if (!appScheduleDate) {
      return null;
    }

    const staffText =
      extractDisplayText(
        pickField(fields, ['fldfjQjmQU', '人员（文本）', '人员文本']),
      ) ||
      extractDisplayValues(pickField(fields, ['fldJ9t028M', '值班人员'])).join(
        ',',
      );

    return {
      id: recordId,
      recordId,
      appShiftId:
        extractDisplayText(pickField(fields, ['fldB1kenQn', '值班编号'])) ||
        null,
      appCode: extractFeishuNumberValue(
        pickField(fields, ['fldDV2MRvm', '编码']),
      ),
      appScheduleDate,
      appHeavyType:
        extractDisplayText(pickField(fields, ['fldTl2QqfX', '重保类型'])) ||
        null,
      appScheduleDateWeek:
        extractDisplayText(
          pickField(fields, ['fldUeKC4Ki', '排班日期（星期）']),
        ) || null,
      appYearWeek:
        extractDisplayText(pickField(fields, ['fld1rMmyqh', '年度周数'])) ||
        null,
      appDutyBuilding:
        extractDisplayText(pickField(fields, ['fldvuTfj3X', '值守机楼'])) ||
        null,
      appDutyStaff: extractDisplayValues(
        pickField(fields, ['fldJ9t028M', '值班人员']),
      ),
      appStaffText: staffText || null,
    };
  }

  private async fetchFeishuOrganizationRecords(
    forceRefresh = false,
  ): Promise<BitableRecordItem[]> {
    return fetchBitableRecords(this.httpService, {
      appToken: this.ORG_APP_TOKEN,
      tableId: this.ORG_TABLE_ID,
      viewId: this.ORG_VIEW_ID || undefined,
      tableName: '在职人员',
      forceRefresh,
    });
  }

  private async fetchFeishuPersonProfileRecords(
    forceRefresh = false,
    scope: PersonProfileScope = 'leave',
    includeDetails = false,
  ): Promise<BitableRecordItem[]> {
    const planOptions = {
      leaveTableId: this.LEAVE_PERSON_PROFILE_TABLE_ID,
      travelTableId: this.ORG_TABLE_ID,
      travelViewId: this.TRAVEL_PERSON_PROFILE_VIEW_ID,
    };
    const plan = includeDetails
      ? resolvePersonProfileDetailReadPlan(scope, planOptions)
      : resolvePersonProfileReadPlan(scope, planOptions);
    const appToken =
      scope === 'leave'
        ? await resolveBitableAppToken(this.httpService, {
            appToken: this.LEAVE_PERSON_PROFILE_APP_TOKEN,
            wikiToken: this.LEAVE_PERSON_PROFILE_WIKI_TOKEN,
            tableName: plan.tableName,
          })
        : this.ORG_APP_TOKEN;

    return fetchBitableRecords(this.httpService, {
      appToken,
      tableId: plan.tableId,
      viewId: plan.viewId,
      fieldNames: plan.fieldNames,
      tableName: plan.tableName,
      cacheTtlMs: plan.cacheTtlMs,
      forceRefresh,
      strict: plan.strict,
      allowStale: plan.allowStale,
    });
  }

  private async readCachedPersonProfileRecords(
    scope: PersonProfileScope = 'leave',
    includeDetails = false,
  ): Promise<BitableRecordItem[]> {
    const planOptions = {
      leaveTableId: this.LEAVE_PERSON_PROFILE_TABLE_ID,
      travelTableId: this.ORG_TABLE_ID,
      travelViewId: this.TRAVEL_PERSON_PROFILE_VIEW_ID,
    };
    const plan = includeDetails
      ? resolvePersonProfileDetailReadPlan(scope, planOptions)
      : resolvePersonProfileReadPlan(scope, planOptions);
    let snapshot = await readLatestPersistedBitableRecordSnapshot({
      appToken:
        (scope === 'leave'
          ? this.LEAVE_PERSON_PROFILE_APP_TOKEN
          : this.ORG_APP_TOKEN) || undefined,
      tableId: plan.tableId,
      viewId: plan.viewId,
      tableName: plan.tableName,
      fieldNames: plan.fieldNames,
    });

    // 详情投影包含全部公开字段；公开快照尚未暖机时可安全降级读取详情并在映射时脱敏。
    if (!snapshot && !includeDetails) {
      const detailPlan = resolvePersonProfileDetailReadPlan(scope, planOptions);
      snapshot = await readLatestPersistedBitableRecordSnapshot({
        appToken:
          (scope === 'leave'
            ? this.LEAVE_PERSON_PROFILE_APP_TOKEN
            : this.ORG_APP_TOKEN) || undefined,
        tableId: detailPlan.tableId,
        viewId: detailPlan.viewId,
        tableName: detailPlan.tableName,
        fieldNames: detailPlan.fieldNames,
      });
    }

    if (!snapshot) {
      throw new Error('本地人员资料缓存尚未准备完成');
    }
    return snapshot.records;
  }

  private async getNonDutySchedulesFromFeishu(
    params: {
      startDate?: string;
      endDate?: string;
      building?: string;
      team?: string;
    } = {},
  ): Promise<{ schedules: NonDutySchedule[] }> {
    const records = await this.fetchFeishuNonDutyRecords();
    const schedules = records
      .map((record) => this.mapFeishuNonDutyRecord(record))
      .filter((schedule): schedule is NonDutySchedule => {
        if (!schedule) return false;
        if (
          params.startDate &&
          (!schedule.scheduleDate || schedule.scheduleDate < params.startDate)
        )
          return false;
        if (
          params.endDate &&
          (!schedule.scheduleDate || schedule.scheduleDate > params.endDate)
        )
          return false;
        if (params.building && schedule.building !== params.building)
          return false;
        if (params.team && schedule.team !== params.team) return false;
        return true;
      })
      .sort((a, b) =>
        (a.scheduleDate || '').localeCompare(b.scheduleDate || ''),
      );

    this.logger.log(`飞书直读长白班排班: ${schedules.length} 条`);
    return { schedules };
  }

  private mapFeishuNonDutyRecord(
    record: BitableRecordItem,
  ): NonDutySchedule | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const scheduleDate = extractFeishuDateValue(
      pickField(fields, ['排班日期', '日期', 'schedule_date']),
    );
    if (!scheduleDate) {
      return null;
    }

    const buildingText = extractDisplayText(
      pickField(fields, ['机楼', '楼栋', '值守机楼']),
    );
    const teamText = extractDisplayText(pickField(fields, ['班组', '班别']));
    const approvedLeave = resolveApprovalAwareDutyStaffFromFields(fields);

    return {
      id: recordId,
      recordId,
      dutyCode:
        extractDisplayText(pickField(fields, ['值班编码', '值班编号'])) ||
        recordId,
      code: extractFeishuNumberValue(pickField(fields, ['编码'])),
      scheduleDate,
      building: buildingText,
      team: teamText || normalizeTeamForFrontend(teamText),
      personText: extractDisplayText(
        pickField(fields, ['人员（文本）', '人员']),
      ),
      dutyStaffActual: approvedLeave.dutyStaff.join(' '),
      leaveStaff: approvedLeave.leaveStaff.join(' '),
      leaveStaffBitable: approvedLeave.leaveStaff,
      substituteStaffBitable: approvedLeave.substituteStaff,
      lastModifiedTime: extractDateTimeIso(pickField(fields, ['最新更新时间'])),
    };
  }

  private mapFeishuEmployeeRecordToOrganization(
    record: BitableRecordItem,
  ): NantongOrganization | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const position = this.normalizePositionLabel(
      extractDisplayText(pickField(fields, ['岗位', '楼岗位', '职位']), ' '),
    );

    if (!recordId || !this.isOrganizationPosition(position)) {
      return null;
    }

    const name = extractDisplayText(
      pickField(fields, ['姓名', '员工姓名', '人员', '人员（文本）']),
      ' ',
    );
    if (!name) {
      return null;
    }

    const employeeUsers = this.extractUserIds(
      pickField(fields, ['员工姓名', '人员']),
    );
    const supervisorText = extractDisplayText(
      pickField(fields, ['主管', '直接主管']),
      '、',
    );
    const shift = this.normalizeShiftLabel(
      extractDisplayText(pickField(fields, ['班组', '班次', '班别']), ' '),
    );

    return {
      id: recordId,
      recordId,
      code:
        extractDisplayText(pickField(fields, ['员工工号', '编码']), '') || null,
      position,
      buildingsSpecialties: this.extractEmployeeBuildingProfessional(fields),
      supervisor: employeeUsers[0] || null,
      dutyAccount: employeeUsers,
      supervisorText: name,
      parentRecord: supervisorText || null,
      photoUrl: this.extractEmployeePhotoUrl(fields, recordId),
      email:
        extractDisplayText(pickField(fields, ['电子邮箱', '邮箱']), '') || null,
      phone:
        extractDisplayText(
          pickField(fields, ['联系方式', '电话', '手机号']),
          '',
        ) || null,
      shift,
      createdAt: this.formatFeishuRecordTime(record.created_time),
      updatedAt: this.formatFeishuRecordTime(record.last_modified_time),
    };
  }

  private mapFeishuEmployeeRecordToDutyStaff(
    record: BitableRecordItem,
  ): DutyStaff | null {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const position = this.normalizePositionLabel(
      extractDisplayText(pickField(fields, ['岗位', '楼岗位', '职位']), ' '),
    );

    if (!recordId || !this.isDutyStaffPosition(position)) {
      return null;
    }

    const appName = extractDisplayText(
      pickField(fields, ['姓名', '员工姓名', '人员', '人员（文本）']),
      ' ',
    );
    if (!appName) {
      return null;
    }

    return {
      id: recordId,
      profileSource: 'organization',
      appName,
      position,
      buildingProfessional: this.extractEmployeeBuildingProfessional(fields),
      shift: this.normalizeShiftLabel(
        extractDisplayText(pickField(fields, ['班组', '班次', '班别']), ' '),
      ),
      photoUrl: this.extractEmployeePhotoUrl(fields, recordId),
      email:
        extractDisplayText(pickField(fields, ['电子邮箱', '邮箱']), '') || null,
      phone:
        extractDisplayText(
          pickField(fields, ['联系方式', '电话', '手机号']),
          '',
        ) || null,
    };
  }

  private mapFeishuEmployeeRecordToPersonProfile(
    record: BitableRecordItem,
  ): PersonProfile | null {
    const fields = record.fields || {};
    const name = extractDisplayText(
      pickField(fields, ['姓名', '员工姓名', '人员', '人员（文本）']),
      ' ',
    );

    if (!name) {
      return null;
    }

    const position =
      this.normalizePositionLabel(
        extractDisplayText(pickField(fields, ['岗位', '楼岗位', '职位']), ' '),
      ) || '人员';

    return {
      supervisorText: name,
      position,
      buildingsSpecialties: this.extractEmployeeBuildingProfessional(fields),
      shift: this.normalizeShiftLabel(
        extractDisplayText(pickField(fields, ['班组', '班次', '班别']), ' '),
      ),
    };
  }

  private mapFeishuEmployeeRecordToPersonProfileDetail(
    record: BitableRecordItem,
    scope: PersonProfileScope,
  ): PersonProfileDetail | null {
    const profile = this.mapFeishuEmployeeRecordToPersonProfile(record);
    const recordId = getRecordId(record);
    if (!profile || !recordId) {
      return null;
    }
    const fields = record.fields || {};
    const openId = extractFeishuOpenId(
      pickField(fields, ['员工姓名', '员工', '人员']),
    );
    return {
      ...profile,
      recordId,
      photoUrl: this.extractEmployeePhotoUrl(fields, recordId, scope),
      phone:
        extractDisplayText(
          pickField(fields, ['联系方式', '电话', '手机号']),
          '',
        ) || null,
      feishuChatUrl: openId
        ? `/api/bitable/person-chat/${encodeURIComponent(recordId)}?scope=${scope}`
        : null,
    };
  }

  private mapFeishuEmployeeRecordsToOrganizations(
    records: BitableRecordItem[],
  ): NantongOrganization[] {
    const positionOrder = new Map(
      [
        '设施运维经理',
        '设施运维副经理',
        '设施运维主管',
        '弱电主管',
        '电气主管',
        '暖通主管',
        '消防主管',
        '综合管理',
        '安全&消防工程师',
        '消防工程师',
        '电气工程师',
        '暖通工程师',
        '弱电工程师',
        'FOC',
      ].map((position, index) => [position, index]),
    );

    return records
      .map((record) => this.mapFeishuEmployeeRecordToOrganization(record))
      .filter((record): record is NantongOrganization => Boolean(record))
      .sort((a, b) => {
        const positionCompare =
          (positionOrder.get(a.position) ?? 99) -
          (positionOrder.get(b.position) ?? 99);
        if (positionCompare !== 0) {
          return positionCompare;
        }
        return (a.supervisorText || '').localeCompare(
          b.supervisorText || '',
          'zh-CN',
        );
      });
  }

  private mapFeishuEmployeeRecordsToDutyStaff(
    records: BitableRecordItem[],
  ): DutyStaff[] {
    return records
      .map((record) => this.mapFeishuEmployeeRecordToDutyStaff(record))
      .filter((record): record is DutyStaff => Boolean(record));
  }

  private mapFeishuEmployeeRecordsToPersonProfiles(
    records: BitableRecordItem[],
  ): PersonProfile[] {
    return records
      .map((record) => this.mapFeishuEmployeeRecordToPersonProfile(record))
      .filter((record): record is PersonProfile => Boolean(record))
      .sort((a, b) =>
        (a.supervisorText || '').localeCompare(b.supervisorText || '', 'zh-CN'),
      );
  }

  private mapFeishuEmployeeRecordsToPersonProfileDetails(
    records: BitableRecordItem[],
    scope: PersonProfileScope,
  ): PersonProfileDetail[] {
    return records
      .map((record) =>
        this.mapFeishuEmployeeRecordToPersonProfileDetail(record, scope),
      )
      .filter((record): record is PersonProfileDetail => Boolean(record))
      .sort((a, b) =>
        a.supervisorText.localeCompare(b.supervisorText, 'zh-CN'),
      );
  }

  private extractEmployeeBuildingProfessional(
    fields: Record<string, unknown>,
  ): string[] {
    const values = extractDisplayValues(
      pickField(fields, ['机楼/专业', '楼栋/专业', '楼栋', '机楼', '值守机楼']),
    );
    const normalized = values
      .flatMap((value) => value.split(/[、,，/]/))
      .map((value) => this.normalizeBuildingProfessionalLabel(value))
      .filter(Boolean);

    return Array.from(new Set(normalized));
  }

  private extractEmployeePhotoUrl(
    fields: Record<string, unknown>,
    recordId?: string,
    scope?: PersonProfileScope,
  ): string | null {
    const value = this.pickEmployeePhotoField(fields);
    const urls = this.extractAttachmentUrls(value);
    const fileTokens = this.extractAttachmentFileTokens(value);
    if (recordId && (urls.length > 0 || fileTokens.length > 0)) {
      const scopeQuery = scope ? `?scope=${scope}` : '';
      return `/api/bitable/employee-photo/${encodeURIComponent(recordId)}${scopeQuery}`;
    }
    return urls[0] || null;
  }

  private pickEmployeePhotoField(fields: Record<string, unknown>): unknown {
    return pickField(fields, [
      '照片',
      '头像',
      '员工照片',
      '简历照片（一寸）',
      '简历照片',
    ]);
  }

  private extractAttachmentUrls(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.extractAttachmentUrls(item));
    }
    if (typeof value === 'string') {
      return value.startsWith('http') ? [value] : [];
    }
    if (typeof value === 'object' && value !== null) {
      const item = value as Record<string, unknown>;
      const url =
        item.tmp_url ||
        item.tmpUrl ||
        item.tmp_download_url ||
        item.tmpDownloadUrl ||
        item.url ||
        item.download_url ||
        item.downloadUrl;
      if (typeof url === 'string' && url.startsWith('http')) {
        return [url];
      }
    }
    return [];
  }

  private extractAttachmentFileTokens(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return Array.from(
        new Set(
          value.flatMap((item) => this.extractAttachmentFileTokens(item)),
        ),
      );
    }
    if (typeof value === 'object' && value !== null) {
      const item = value as Record<string, unknown>;
      const token = item.file_token || item.fileToken || item.token;
      return typeof token === 'string' && token.trim() ? [token.trim()] : [];
    }
    return [];
  }

  private normalizeBuildingProfessionalLabel(value: string): string {
    const text = value.trim();
    if (!text || /^opt[A-Za-z0-9]+$/.test(text)) {
      return '';
    }
    if (text.includes('110')) return '110站';
    if (/^H$/i.test(text) || text.includes('H楼') || text.includes('H栋'))
      return 'H楼';
    if (/^A$/i.test(text) || text.includes('A楼') || text.includes('A栋'))
      return 'A楼';
    if (/^B$/i.test(text) || text.includes('B楼') || text.includes('B栋'))
      return 'B楼';
    if (/^C$/i.test(text) || text.includes('C楼') || text.includes('C栋'))
      return 'C楼';
    if (/^D$/i.test(text) || text.includes('D楼') || text.includes('D栋'))
      return 'D楼';
    if (/^E$/i.test(text) || text.includes('E楼') || text.includes('E栋'))
      return 'E楼';
    return text;
  }

  private normalizePositionLabel(value: string): string {
    return value.trim().replace(/\s+/g, '');
  }

  private normalizeShiftLabel(value: string): string | null {
    const text = value.trim();
    if (!text) return null;
    if (/^A$/i.test(text) || text.includes('A班')) return 'A班';
    if (/^B$/i.test(text) || text.includes('B班')) return 'B班';
    if (/^C$/i.test(text) || text.includes('C班')) return 'C班';
    if (/^D$/i.test(text) || text.includes('D班')) return 'D班';
    if (text.includes('长白')) return '长白';
    return text;
  }

  private isOrganizationPosition(position: string): boolean {
    return new Set([
      '设施运维经理',
      '设施运维主管',
      '弱电主管',
      '电气主管',
      '暖通主管',
      '设施运维副经理',
      '综合管理',
      '电气工程师',
      '暖通工程师',
      '弱电工程师',
      '安全&消防工程师',
      '消防工程师',
      '消防主管',
      'FOC',
    ]).has(position);
  }

  private isDutyStaffPosition(position: string): boolean {
    return new Set([
      '运维值班长',
      '运维值班员',
      '运维实习生',
      '110值班人员',
      '110站站长',
      'H楼值班主管',
    ]).has(position);
  }

  private formatFeishuRecordTime(value?: number): string {
    if (!value || !Number.isFinite(value)) {
      return new Date().toISOString();
    }
    const timestamp = value > 1000000000000 ? value : value * 1000;
    return new Date(timestamp).toISOString();
  }

  private buildDutyStaffByBuilding(staff: DutyStaff[]): DutyStaffByBuilding[] {
    const buildingMap = new Map<
      string,
      Map<string, { leader: DutyStaff | null; staff: DutyStaff | null }>
    >();
    const buildingNameMap: Record<string, string> = {
      H楼: 'H楼',
      A楼: 'A楼',
      B楼: 'B楼',
      C楼: 'C楼',
      D楼: 'D楼',
      E楼: 'E楼',
      '110站': '110站',
    };
    const shiftNameMap: Record<string, string> = {
      A班: 'A班',
      B班: 'B班',
      C班: 'C班',
      D班: 'D班',
    };
    const station110Staff: DutyStaff[] = [];
    let station110Chief: DutyStaff | null = null;

    staff.forEach((person) => {
      const buildings = person.buildingProfessional || [];
      const shift = person.shift || '';
      const position = person.position || '';

      buildings.forEach((building) => {
        let normalizedBuilding = building;
        if (!buildingNameMap[building]) {
          const match = Object.keys(buildingNameMap).find((key) =>
            building.includes(key),
          );
          if (match) {
            normalizedBuilding = match;
          } else {
            return;
          }
        }

        if (normalizedBuilding === '110站') {
          if (position === '110站站长') {
            station110Chief = person;
          } else {
            station110Staff.push(person);
          }
          return;
        }

        let normalizedShift = shift;
        if (!shiftNameMap[shift]) {
          const match = Object.keys(shiftNameMap).find((key) =>
            shift.includes(key),
          );
          normalizedShift = match || 'A班';
        }

        if (!buildingMap.has(normalizedBuilding)) {
          buildingMap.set(normalizedBuilding, new Map());
        }

        const shiftMap = buildingMap.get(normalizedBuilding)!;
        if (!shiftMap.has(normalizedShift)) {
          shiftMap.set(normalizedShift, { leader: null, staff: null });
        }

        const shiftData = shiftMap.get(normalizedShift)!;
        if (position === '运维值班长' || position === 'H楼值班主管') {
          shiftData.leader = person;
        } else if (position === '运维值班员' || position === '运维实习生') {
          shiftData.staff = person;
        }
      });
    });

    const result = Array.from(buildingMap.entries()).map(
      ([building, shiftMap]) => {
        const shifts = Array.from(shiftMap.entries()).map(([shift, data]) => ({
          shift,
          leader: data.leader,
          staff: data.staff,
        }));
        const shiftOrder = ['A班', 'B班', 'C班', 'D班'];
        shifts.sort(
          (a, b) => shiftOrder.indexOf(a.shift) - shiftOrder.indexOf(b.shift),
        );
        return { building, shifts };
      },
    );

    if (station110Staff.length > 0 || station110Chief) {
      const staffList = station110Staff.slice(0, 7);
      while (staffList.length < 7) {
        staffList.push(null as unknown as DutyStaff);
      }

      result.push({
        building: '110站',
        shifts: [
          { shift: '站长', leader: null, staff: station110Chief },
          ...staffList.map((person, index) => ({
            shift: `值班员${index + 1}`,
            leader: null,
            staff: person,
          })),
        ],
      });
    }

    const buildingOrder = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'];
    result.sort(
      (a, b) =>
        buildingOrder.indexOf(a.building) - buildingOrder.indexOf(b.building),
    );

    return result;
  }

  private createTodayLeaveBuildingData(): TodayLeaveBuildingData {
    return {
      leaveStaff: new Set<string>(),
      substituteStaff: new Set<string>(),
      temporarySubstituteStaff: new Set<string>(),
      temporarySubstitutesByShift: new Map<
        string,
        TodayTemporarySubstituteGroup
      >(),
    };
  }

  private getOrCreateTodayLeaveBuildingData(
    buildingData: Map<string, TodayLeaveBuildingData>,
    buildingName: string,
  ): TodayLeaveBuildingData {
    const existing = buildingData.get(buildingName);
    if (existing) {
      return existing;
    }

    const created = this.createTodayLeaveBuildingData();
    buildingData.set(buildingName, created);
    return created;
  }

  private normalizeTodayTemporarySubstituteShift(
    shiftValue: string | null | undefined,
  ): {
    shift: string;
    shiftLabel: string;
  } {
    const text = String(shiftValue || '').trim();
    const normalized = text.toLowerCase().replace(/[\s-]+/g, '_');

    if (
      normalized.includes('long_white') ||
      normalized.includes('longwhite') ||
      text.includes('长白')
    ) {
      return { shift: 'long_white', shiftLabel: '长白' };
    }
    if (normalized.includes('night') || text.includes('夜')) {
      return { shift: 'night', shiftLabel: '夜' };
    }
    if (normalized.includes('white') || text.includes('白')) {
      return { shift: 'white', shiftLabel: '白' };
    }

    return { shift: text || 'temporary', shiftLabel: text || '临时' };
  }

  private addTodayTemporarySubstituteStaff(
    data: TodayLeaveBuildingData,
    shiftValue: string | null | undefined,
    staffNames: string[],
  ): void {
    const names = staffNames
      .flatMap((name) => this.splitStaffNames(name))
      .filter(Boolean);
    if (names.length === 0) {
      return;
    }

    const { shift, shiftLabel } =
      this.normalizeTodayTemporarySubstituteShift(shiftValue);
    const key = shift || shiftLabel || 'temporary';
    const group = data.temporarySubstitutesByShift.get(key) || {
      shift,
      shiftLabel,
      staff: new Set<string>(),
    };

    for (const name of names) {
      data.temporarySubstituteStaff.add(name);
      group.staff.add(name);
    }
    data.temporarySubstitutesByShift.set(key, group);
  }

  private getTodayLeaveBuildingCode(buildingName: string): string {
    const normalized = normalizeBuildingForFrontend(buildingName);
    if (normalized === 'station_110') {
      return '110';
    }
    if (normalized.startsWith('building_')) {
      return normalized.replace('building_', '').toUpperCase();
    }
    return buildingName.replace('栋', '').replace('站', '');
  }

  private async getTodayLeaveStaffFromFeishu(
    date: string,
    forceRefresh = false,
  ): Promise<TodayLeaveStaffResponse> {
    const [nonDutyRecords, scheduleRecords] = await Promise.all([
      this.fetchFeishuNonDutyRecords(forceRefresh),
      this.fetchFeishuScheduleRecords(forceRefresh),
    ]);
    const buildingData = new Map<string, TodayLeaveBuildingData>();

    const getBuildingData = (
      buildingValue: unknown,
    ): TodayLeaveBuildingData | null => {
      const buildingText = extractDisplayText(buildingValue);
      if (!buildingText) return null;

      const buildingName = normalizeBuildingLabel(buildingText);
      return this.getOrCreateTodayLeaveBuildingData(buildingData, buildingName);
    };

    const addRecord = (
      buildingValue: unknown,
      leaveStaff: string[],
      substituteStaff: string[],
    ) => {
      const data = getBuildingData(buildingValue);
      if (!data) return;

      leaveStaff
        .flatMap((name) => this.splitStaffNames(name))
        .forEach((name) => data.leaveStaff.add(name));
      substituteStaff
        .flatMap((name) => this.splitStaffNames(name))
        .forEach((name) => data.substituteStaff.add(name));
    };

    const addTemporaryRecord = (
      buildingValue: unknown,
      shiftValue: string | null | undefined,
      temporarySubstituteStaff: string[],
    ) => {
      const data = getBuildingData(buildingValue);
      if (!data) return;

      this.addTodayTemporarySubstituteStaff(
        data,
        shiftValue,
        temporarySubstituteStaff,
      );
    };

    for (const record of nonDutyRecords) {
      const fields = record.fields || {};
      const scheduleDate = extractFeishuDateValue(
        pickField(fields, ['排班日期', '日期']),
      );
      if (scheduleDate !== date) continue;
      const approvedLeave = resolveApprovalAwareDutyStaffFromFields(fields);
      addRecord(
        pickField(fields, ['机楼', '楼栋', '值守机楼']),
        approvedLeave.leaveStaff,
        approvedLeave.substituteStaff,
      );
    }

    for (const record of scheduleRecords) {
      const fields = record.fields || {};
      const scheduleDate = extractFeishuDateValue(
        pickField(fields, ['fldZSaDbGf', '排班日期', '日期']),
      );
      if (scheduleDate !== date) continue;
      const approvedLeave = resolveApprovalAwareDutyStaffFromFields(fields);
      const leaveStaff = approvedLeave.leaveStaff;
      const substituteStaff = approvedLeave.substituteStaff;
      const shiftText = extractDisplayText(
        pickField(fields, ['fldqPpOgW5', '班次', '值班班次']),
      );
      const plannedStaff = extractDisplayValues(
        pickField(fields, ['fldJi5bxBG', '人员（文本）', '人员文本', '人员']),
      ).flatMap((name) => this.splitStaffNames(name));
      const actualStaff = approvedLeave.dutyStaff;
      const inferredLeaveSubstituteStaff =
        leaveStaff.length > 0 && substituteStaff.length === 0
          ? inferActualSubstituteStaff({
              plannedStaff,
              leaveStaff,
              actualStaff,
            })
          : [];
      const inferredTemporarySubstituteStaff =
        substituteStaff.length === 0
          ? inferTemporarySubstituteStaff({
              plannedStaff,
              leaveStaff,
              actualStaff,
            })
          : [];
      const leaveSubstituteStaff =
        leaveStaff.length > 0
          ? [...substituteStaff, ...inferredLeaveSubstituteStaff]
          : [];
      const temporarySubstituteStaff =
        leaveStaff.length === 0
          ? [...substituteStaff, ...inferredTemporarySubstituteStaff]
          : [];
      const buildingValue = pickField(fields, [
        'fldnP4gXMn',
        '机楼',
        '楼栋',
        '值守机楼',
      ]);

      addRecord(buildingValue, leaveStaff, leaveSubstituteStaff);
      addTemporaryRecord(buildingValue, shiftText, temporarySubstituteStaff);
    }

    const order = ['A栋', 'B栋', 'C栋', 'D栋', 'E栋', 'H栋', '110站'];
    const buildings = Array.from(buildingData.entries())
      .map(([buildingName, data]) => ({
        building: this.getTodayLeaveBuildingCode(buildingName),
        buildingName,
        leaveStaff: Array.from(data.leaveStaff),
        substituteStaff: Array.from(data.substituteStaff),
        temporarySubstituteStaff: Array.from(data.temporarySubstituteStaff),
        temporarySubstitutes: Array.from(
          data.temporarySubstitutesByShift.values(),
        ).map((group) => ({
          shift: group.shift,
          shiftLabel: group.shiftLabel,
          staff: Array.from(group.staff),
        })),
      }))
      .filter(
        (item) =>
          item.leaveStaff.length > 0 ||
          item.substituteStaff.length > 0 ||
          item.temporarySubstituteStaff.length > 0,
      )
      .sort(
        (a, b) => order.indexOf(a.buildingName) - order.indexOf(b.buildingName),
      );

    return {
      date,
      buildings,
      totalLeaveCount: buildings.reduce(
        (sum, item) => sum + item.leaveStaff.length,
        0,
      ),
    };
  }

  private splitStaffNames(value: string | null | undefined): string[] {
    const text = String(value || '').trim();
    if (!text) {
      return [];
    }
    return text
      .split(/[\s、,，;；/]+/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  private async getTenantAccessToken(): Promise<string> {
    const tokenResponse = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      getFeishuAuthPayload(),
    );

    return tokenResponse.data.tenant_access_token;
  }

  async getEmployeePhoto(
    recordId: string,
    scope: PersonProfilePhotoScope = 'organization',
  ): Promise<{
    contentType: string;
    buffer: Buffer;
  } | null> {
    const normalizedRecordId = decodeURIComponent(recordId);
    const cacheKey = `${scope}:${normalizedRecordId}`;
    const cached = this.employeePhotoCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { contentType: cached.contentType, buffer: cached.buffer };
    }

    try {
      const records =
        scope === 'organization'
          ? await this.fetchFeishuOrganizationRecords()
          : await this.readCachedPersonProfileRecords(scope, true);
      const record = records.find(
        (item) => getRecordId(item) === normalizedRecordId,
      );
      if (!record?.fields) {
        return null;
      }

      const photoFieldValue = this.pickEmployeePhotoField(record.fields);
      const fieldAttachmentUrls = this.extractAttachmentUrls(photoFieldValue);
      const fieldPhotoUrl =
        fieldAttachmentUrls.find((url) =>
          url.includes('batch_get_tmp_download_url'),
        ) ||
        fieldAttachmentUrls.find((url) =>
          /\.(png|jpe?g|webp)(\?|$)/i.test(url),
        ) ||
        fieldAttachmentUrls[0];
      const tenantAccessToken = await this.getTenantAccessToken();
      if (fieldPhotoUrl) {
        const photo = await this.downloadEmployeePhotoFromUrl(
          fieldPhotoUrl,
          tenantAccessToken,
        );
        if (photo) {
          this.cacheEmployeePhoto(cacheKey, photo);
          return photo;
        }
      }

      const fileToken = this.extractAttachmentFileTokens(photoFieldValue)[0];
      if (!fileToken) {
        return null;
      }
      const photo = await this.downloadEmployeePhotoFromFileToken(
        fileToken,
        tenantAccessToken,
      );
      if (photo) {
        this.cacheEmployeePhoto(cacheKey, photo);
      }
      return photo;
    } catch (error) {
      this.logger.warn(
        `获取员工照片失败: ${normalizedRecordId} ${(error as Error).message}`,
      );
      return null;
    }
  }

  private cacheEmployeePhoto(
    cacheKey: string,
    photo: {
      contentType: string;
      buffer: Buffer;
    },
  ): void {
    this.employeePhotoCache.set(cacheKey, {
      ...photo,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
  }

  private async downloadEmployeePhotoFromUrl(
    photoUrl: string,
    tenantAccessToken: string,
  ): Promise<{
    contentType: string;
    buffer: Buffer;
  } | null> {
    const downloadUrl = photoUrl.includes('batch_get_tmp_download_url')
      ? await this.resolveFeishuTmpDownloadUrl(photoUrl, tenantAccessToken)
      : photoUrl;
    if (!downloadUrl) {
      return null;
    }

    const imageResponse = await this.httpService.axiosRef.get<ArrayBuffer>(
      downloadUrl,
      {
        responseType: 'arraybuffer',
        headers: downloadUrl.includes('open.feishu.cn/open-apis/')
          ? { Authorization: `Bearer ${tenantAccessToken}` }
          : undefined,
        timeout: 20000,
      },
    );
    const headerContentType = imageResponse.headers['content-type'];
    const contentType =
      typeof headerContentType === 'string' &&
      headerContentType.startsWith('image/')
        ? headerContentType
        : 'image/jpeg';
    return {
      contentType,
      buffer: Buffer.from(imageResponse.data),
    };
  }

  private async downloadEmployeePhotoFromFileToken(
    fileToken: string,
    tenantAccessToken: string,
  ): Promise<{
    contentType: string;
    buffer: Buffer;
  } | null> {
    const batchUrl =
      `https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url` +
      `?file_tokens=${encodeURIComponent(fileToken)}`;
    const photoFromTmpUrl = await this.downloadEmployeePhotoFromUrl(
      batchUrl,
      tenantAccessToken,
    ).catch(() => null);
    if (photoFromTmpUrl) {
      return photoFromTmpUrl;
    }

    const directUrl = `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(
      fileToken,
    )}/download`;
    return this.downloadEmployeePhotoFromUrl(
      directUrl,
      tenantAccessToken,
    ).catch(() => null);
  }

  private async resolveFeishuTmpDownloadUrl(
    batchUrl: string,
    tenantAccessToken: string,
  ): Promise<string | null> {
    const response = await this.httpService.axiosRef.get(batchUrl, {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      timeout: 20000,
    });
    const data = response.data?.data || {};
    const tmpDownloadUrls = data.tmp_download_urls;
    if (Array.isArray(tmpDownloadUrls)) {
      for (const item of tmpDownloadUrls) {
        if (typeof item === 'string' && item.startsWith('http')) {
          return item;
        }
        if (typeof item === 'object' && item !== null) {
          const url =
            (item as Record<string, unknown>).tmp_download_url ||
            (item as Record<string, unknown>).tmpDownloadUrl ||
            (item as Record<string, unknown>).url;
          if (typeof url === 'string' && url.startsWith('http')) {
            return url;
          }
        }
      }
    }
    return typeof data.tmp_download_url === 'string' &&
      data.tmp_download_url.startsWith('http')
      ? data.tmp_download_url
      : null;
  }

  /**
   * 从飞书多维表格同步数据到数据库
   */
  async syncFromBitable() {
    // 检查是否正在同步
    if (this.isSyncing) {
      this.logger.warn('同步任务正在进行中，跳过本次同步请求');
      return {
        success: false,
        total: 0,
        message: '同步任务正在进行中，请稍后再试',
      };
    }

    if (isDatabaseDisabled()) {
      return {
        success: true,
        total: 0,
        inserted: 0,
        updated: 0,
        failed: 0,
        message:
          '本地数据库未启用，封网信息同步已跳过；排班页面使用飞书直读数据',
      };
    }

    this.isSyncing = true;
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalFailed = 0;
    const failedRecords: Array<{ recordId: string; error: string }> = [];

    try {
      this.logger.log('开始从飞书多维表格同步数据');
      assertBitableTableConfig('封网信息', this.APP_TOKEN, this.TABLE_ID);
      this.logger.log(
        `使用封网信息表配置：${maskSecret(this.APP_TOKEN)} / ${this.TABLE_ID}`,
      );

      const tenantAccessToken = await this.getTenantAccessToken();
      this.logger.log('获取 tenant_access_token 成功');

      // 直接调用飞书 API 获取多维表记录
      const records: Array<{ id: string; record: Record<string, unknown> }> =
        [];
      let pageToken: string | undefined;
      const pageSize = 500; // 最大分页大小
      let hasMore = true;
      let pageCount = 0;

      do {
        pageCount++;
        this.logger.log(`获取第 ${pageCount} 页数据`);

        const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.APP_TOKEN}/tables/${this.TABLE_ID}/records`;
        const response = await this.httpService.axiosRef.get(apiUrl, {
          headers: {
            Authorization: 'Bearer ' + tenantAccessToken,
          },
          params: {
            page_size: pageSize,
            page_token: pageToken,
            view_id: this.SEALING_VIEW_ID || undefined,
          },
          timeout: 30000,
        });

        if (response.data.code !== 0) {
          throw new Error(`飞书 API 错误: ${response.data.msg}`);
        }

        const currentBatch = response.data.data.items || [];
        records.push(...currentBatch);
        pageToken = response.data.data.page_token;
        hasMore = response.data.data.has_more;

        this.logger.log(
          `第 ${pageCount} 页获取到 ${currentBatch.length} 条记录，累计 ${records.length} 条`,
        );

        // 处理当前批次的每条记录
        for (const item of currentBatch) {
          try {
            const recordId = item.id;
            const recordContent = item.fields; // 飞书 API 使用 fields 而不是 record

            // 检查 recordContent 是否存在
            if (!recordContent) {
              this.logger.warn(`记录 ${recordId} 的 fields 为空，跳过`);
              continue;
            }

            // 检查记录是否已存在
            const existingRecord = await this.db
              .select()
              .from(appBitableSyncRecords)
              .where(eq(appBitableSyncRecords.bitableRecordId, recordId))
              .limit(1);

            if (existingRecord.length > 0) {
              // 更新已有记录
              await this.db
                .update(appBitableSyncRecords)
                .set({
                  recordContent: recordContent,
                  syncTime: new Date(),
                  status: 'active',
                })
                .where(eq(appBitableSyncRecords.bitableRecordId, recordId));
              totalUpdated++;
            } else {
              // 插入新记录
              await this.db.insert(appBitableSyncRecords).values({
                bitableRecordId: recordId,
                recordContent: recordContent,
                syncTime: new Date(),
                status: 'active',
              });
              totalInserted++;
            }

            // 同步到封网信息表
            await this.syncSealingInfo(recordId, recordContent);
          } catch (error) {
            totalFailed++;
            const errorMsg =
              error instanceof Error ? error.message : 'Unknown error';
            failedRecords.push({
              recordId: item.id || 'unknown',
              error: errorMsg,
            });
            this.logger.error(`处理记录失败: ${item.id}`, error);
          }
        }
      } while (hasMore);

      // 更新最后同步时间
      await this.updateLastSyncTime();

      // 更新今日封网标记
      await this.updateTodaySealingStatus();

      const message =
        `同步完成: 新增 ${totalInserted} 条, 更新 ${totalUpdated} 条` +
        (totalFailed > 0 ? `, 失败 ${totalFailed} 条` : '');

      this.logger.log(message);

      return {
        success: true,
        total: totalInserted + totalUpdated,
        inserted: totalInserted,
        updated: totalUpdated,
        failed: totalFailed,
        failedRecords: totalFailed > 0 ? failedRecords : undefined,
        message,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('同步数据失败', error);
      return {
        success: false,
        total: 0,
        message: `同步失败: ${errorMsg}`,
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 获取已同步的多维表记录
   */
  async getBitableRecords(page = 1, pageSize = 20) {
    try {
      const offset = (page - 1) * pageSize;

      const records = await this.db
        .select()
        .from(appBitableSyncRecords)
        .where(eq(appBitableSyncRecords.status, 'active'))
        .orderBy(desc(appBitableSyncRecords.syncTime))
        .limit(pageSize)
        .offset(offset);

      const totalResult = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(appBitableSyncRecords)
        .where(eq(appBitableSyncRecords.status, 'active'));

      const total = totalResult[0]?.count || 0;

      return {
        records,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      };
    } catch (error) {
      this.logger.error('获取多维表记录失败', error);
      throw error;
    }
  }

  /**
   * 获取最后同步时间
   */
  async getLastSyncTime(): Promise<string | null> {
    try {
      const result = await this.db
        .select()
        .from(appSyncConfig)
        .where(eq(appSyncConfig.configKey, 'bitable_last_sync_time'))
        .limit(1);

      return result[0]?.configValue || null;
    } catch (error) {
      this.logger.error('获取最后同步时间失败', error);
      return null;
    }
  }

  /**
   * 更新最后同步时间
   */
  private async updateLastSyncTime(): Promise<void> {
    try {
      const now = new Date().toISOString();
      const existing = await this.db
        .select()
        .from(appSyncConfig)
        .where(eq(appSyncConfig.configKey, 'bitable_last_sync_time'))
        .limit(1);

      if (existing.length > 0) {
        await this.db
          .update(appSyncConfig)
          .set({ configValue: now })
          .where(eq(appSyncConfig.configKey, 'bitable_last_sync_time'));
      } else {
        await this.db.insert(appSyncConfig).values({
          configKey: 'bitable_last_sync_time',
          configValue: now,
        });
      }
    } catch (error) {
      this.logger.error('更新最后同步时间失败', error);
    }
  }

  /**
   * 同步封网信息到专用表
   */
  private async syncSealingInfo(
    recordId: string,
    recordContent: Record<string, unknown>,
  ): Promise<void> {
    try {
      // 解析封网信息字段
      const sealingName = this.extractTextValue(recordContent['封网信息']);
      const sealingCode = this.extractTextValue(recordContent['编号']);
      const autoNumber = this.extractTextValue(recordContent['自增编号']);
      const startDate = this.extractTimestamp(recordContent['开始日期']);
      const endDate = this.extractTimestamp(recordContent['结束日期']);
      const isToday =
        this.extractTextValue(recordContent['判断是否为今日']) === 'true';

      // 检查记录是否已存在
      const existing = await this.db
        .select()
        .from(appSealingInfo)
        .where(eq(appSealingInfo.bitableRecordId, recordId))
        .limit(1);

      // 如果 sealingName 为空，删除已有记录
      if (!sealingName || sealingName.trim() === '') {
        if (existing.length > 0) {
          await this.db
            .delete(appSealingInfo)
            .where(eq(appSealingInfo.bitableRecordId, recordId));
          this.logger.log(`已删除 sealing_name 为空的封网记录: ${recordId}`);
        }
        return;
      }

      // 从封网信息中提取类型（强管控/弱管控）
      let sealingType: string | null = null;
      if (sealingName.includes('强管控')) {
        sealingType = '强管控';
      } else if (sealingName.includes('弱管控')) {
        sealingType = '弱管控';
      }

      if (existing.length > 0) {
        // 更新已有记录
        await this.db
          .update(appSealingInfo)
          .set({
            sealingCode: sealingCode || '',
            sealingName: sealingName,
            startDate: startDate ? new Date(startDate) : new Date(),
            endDate: endDate ? new Date(endDate) : new Date(),
            sealingType,
            autoNumber,
            isToday,
          })
          .where(eq(appSealingInfo.bitableRecordId, recordId));
      } else {
        // 插入新记录
        await this.db.insert(appSealingInfo).values({
          bitableRecordId: recordId,
          sealingCode: sealingCode || '',
          sealingName: sealingName,
          startDate: startDate ? new Date(startDate) : new Date(),
          endDate: endDate ? new Date(endDate) : new Date(),
          sealingType,
          autoNumber,
          isToday,
        });
      }
    } catch (error) {
      this.logger.error(`同步封网信息失败: ${recordId}`, error);
    }
  }

  /**
   * 更新今日封网状态
   */
  private async updateTodaySealingStatus(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // 将所有记录的 is_today 设为 false
      await this.db.update(appSealingInfo).set({ isToday: false });

      // 将今日封网的记录设为 true
      await this.db
        .update(appSealingInfo)
        .set({ isToday: true })
        .where(
          sql`${appSealingInfo.startDate} < ${tomorrow.toISOString()} AND ${appSealingInfo.endDate} > ${today.toISOString()}`,
        );

      this.logger.log('今日封网状态已更新');
    } catch (error) {
      this.logger.error('更新今日封网状态失败', error);
    }
  }

  /**
   * 提取文本值
   */
  private extractTextValue(field: unknown): string | null {
    if (!field) return null;

    // 如果是数组（飞书文本字段格式）
    if (Array.isArray(field) && field.length > 0) {
      const firstItem = field[0];
      if (
        typeof firstItem === 'object' &&
        firstItem !== null &&
        'text' in firstItem
      ) {
        return String(firstItem.text);
      }
    }

    // 如果是字符串
    if (typeof field === 'string') {
      return field;
    }

    return null;
  }

  /**
   * 提取时间戳
   */
  private extractTimestamp(field: unknown): number | null {
    if (typeof field === 'number') {
      return field;
    }
    if (typeof field === 'string') {
      const num = parseInt(field, 10);
      return isNaN(num) ? null : num;
    }
    return null;
  }

  /**
   * 从飞书多维表格同步组织架构数据
   * 同时同步 nantong_organization 和 app_employee_cert_info_formal 两个表
   */
  async syncOrganization() {
    const result = {
      organization: { inserted: 0, updated: 0, failed: 0 },
      employeeCert: { inserted: 0, updated: 0, failed: 0 },
    };

    try {
      if (isDatabaseDisabled()) {
        const records = await this.fetchFeishuOrganizationRecords(true);
        const organizations =
          this.mapFeishuEmployeeRecordsToOrganizations(records);
        const dutyStaff = this.mapFeishuEmployeeRecordsToDutyStaff(records);
        return {
          success: true,
          total: records.length,
          inserted: 0,
          updated: records.length,
          failed: 0,
          details: {
            organization: {
              inserted: 0,
              updated: organizations.length,
              failed: 0,
            },
            employeeCert: { inserted: 0, updated: dutyStaff.length, failed: 0 },
          },
          message: `本地数据库未启用，已刷新在职人员表缓存（${records.length} 条）`,
        };
      }

      this.logger.log('开始从飞书多维表格同步组织架构数据');

      assertBitableTableConfig(
        '组织架构',
        this.ORG_APP_TOKEN,
        this.ORG_TABLE_ID,
      );
      const tenantAccessToken = await this.getTenantAccessToken();
      this.logger.log('获取 tenant_access_token 成功');

      // 同步组织架构表
      const orgResult = await this.syncOrganizationTable(tenantAccessToken);
      result.organization = orgResult;

      // 同步员工证书信息表（失败不影响整体结果）
      try {
        const certResult = await this.syncEmployeeCertTable(tenantAccessToken);
        result.employeeCert = certResult;
      } catch (certError) {
        this.logger.warn(
          '员工证书信息表同步失败（不影响组织架构同步）',
          certError,
        );
        result.employeeCert = { inserted: 0, updated: 0, failed: 0 };
      }

      this.logger.log(
        `同步完成：组织架构(新增${orgResult.inserted},更新${orgResult.updated}), 员工证书(新增${result.employeeCert.inserted},更新${result.employeeCert.updated})`,
      );

      return {
        success: true,
        total:
          orgResult.inserted +
          orgResult.updated +
          result.employeeCert.inserted +
          result.employeeCert.updated,
        inserted: orgResult.inserted + result.employeeCert.inserted,
        updated: orgResult.updated + result.employeeCert.updated,
        failed: orgResult.failed + result.employeeCert.failed,
        details: result,
      };
    } catch (error) {
      this.logger.error('同步组织架构数据失败', error);
      throw error;
    }
  }

  /**
   * 同步组织架构表 (nantong_organization)
   */
  private async syncOrganizationTable(tenantAccessToken: string) {
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalFailed = 0;

    assertBitableTableConfig('组织架构', this.ORG_APP_TOKEN, this.ORG_TABLE_ID);
    this.logger.log(
      `开始同步组织架构表：${maskSecret(this.ORG_APP_TOKEN)} / ${this.ORG_TABLE_ID}`,
    );

    if (this.ORG_VIEW_ID) {
      const records = await this.fetchFeishuOrganizationRecords(true);
      const organizations =
        this.mapFeishuEmployeeRecordsToOrganizations(records);

      for (const org of organizations) {
        try {
          const existingRecord = await this.db
            .select()
            .from(nantongOrganization)
            .where(eq(nantongOrganization.recordId, org.recordId))
            .limit(1);

          const values = {
            code: org.code,
            position: org.position as any,
            buildingsSpecialties: org.buildingsSpecialties,
            supervisor: org.supervisor,
            dutyAccount: org.dutyAccount,
            supervisorText: org.supervisorText,
            parentRecord: org.parentRecord,
          };

          if (existingRecord.length > 0) {
            await this.db
              .update(nantongOrganization)
              .set(values)
              .where(eq(nantongOrganization.recordId, org.recordId));
            totalUpdated++;
          } else {
            await this.db.insert(nantongOrganization).values({
              recordId: org.recordId,
              ...values,
            });
            totalInserted++;
          }
        } catch (error) {
          totalFailed++;
          this.logger.error(
            `处理在职人员组织架构记录失败: ${org.recordId}`,
            error,
          );
        }
      }

      this.logger.log(
        `在职人员组织架构同步完成：新增 ${totalInserted} 条，更新 ${totalUpdated} 条`,
      );
      return {
        inserted: totalInserted,
        updated: totalUpdated,
        failed: totalFailed,
      };
    }

    let pageToken: string | undefined;
    const pageSize = 500;
    let hasMore = true;
    let pageCount = 0;

    do {
      pageCount++;
      const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.ORG_APP_TOKEN}/tables/${this.ORG_TABLE_ID}/records`;
      const response = await this.httpService.axiosRef.get(apiUrl, {
        headers: { Authorization: 'Bearer ' + tenantAccessToken },
        params: { page_size: pageSize, page_token: pageToken },
        timeout: 30000,
      });

      if (response.data.code !== 0) {
        throw new Error(`飞书 API 错误: ${response.data.msg}`);
      }

      const currentBatch = response.data.data.items || [];
      pageToken = response.data.data.page_token;
      hasMore = response.data.data.has_more;

      for (const item of currentBatch) {
        try {
          const recordId = item.id;
          const fields = item.fields;

          const code = fields ? this.extractTextValue(fields['编码']) : null;
          const position = fields
            ? this.extractTextValue(fields['职位'])
            : null;
          const buildingsSpecialties = fields
            ? this.extractMultiSelectValues(fields['楼栋/专业'])
            : [];
          const supervisor = fields
            ? this.extractTextValue(fields['主管'])
            : null;
          const dutyAccount = fields
            ? this.extractUserIds(fields['值班账号'])
            : [];
          const supervisorText = fields
            ? this.extractTextValue(fields['主管（文本）'])
            : null;
          const parentRecord = fields
            ? this.extractTextValue(fields['父记录'])
            : null;

          const existingRecord = await this.db
            .select()
            .from(nantongOrganization)
            .where(eq(nantongOrganization.recordId, recordId))
            .limit(1);

          if (existingRecord.length > 0) {
            await this.db
              .update(nantongOrganization)
              .set({
                code: code || existingRecord[0].code,
                position: (position as any) || existingRecord[0].position,
                buildingsSpecialties:
                  buildingsSpecialties.length > 0
                    ? buildingsSpecialties
                    : existingRecord[0].buildingsSpecialties,
                supervisor: supervisor || existingRecord[0].supervisor,
                dutyAccount:
                  dutyAccount.length > 0
                    ? dutyAccount
                    : existingRecord[0].dutyAccount,
                supervisorText:
                  supervisorText || existingRecord[0].supervisorText,
                parentRecord: parentRecord || existingRecord[0].parentRecord,
              })
              .where(eq(nantongOrganization.recordId, recordId));
            totalUpdated++;
          } else {
            await this.db.insert(nantongOrganization).values({
              recordId: recordId,
              code: code,
              position: (position as any) || '值班账号',
              buildingsSpecialties:
                buildingsSpecialties.length > 0 ? buildingsSpecialties : [],
              supervisor: supervisor,
              dutyAccount: dutyAccount.length > 0 ? dutyAccount : [],
              supervisorText: supervisorText,
              parentRecord: parentRecord,
            });
            totalInserted++;
          }
        } catch (error) {
          totalFailed++;
          this.logger.error(`处理组织架构记录失败: ${item.id}`, error);
        }
      }
    } while (hasMore);

    this.logger.log(
      `组织架构表同步完成：新增 ${totalInserted} 条，更新 ${totalUpdated} 条`,
    );
    return {
      inserted: totalInserted,
      updated: totalUpdated,
      failed: totalFailed,
    };
  }

  /**
   * 同步员工证书信息表 (app_employee_cert_info_formal)
   */
  private async syncEmployeeCertTable(tenantAccessToken: string) {
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalFailed = 0;

    assertBitableTableConfig(
      '员工证书信息',
      this.CERT_APP_TOKEN,
      this.CERT_TABLE_ID,
    );
    this.logger.log(
      `开始同步员工证书信息表：${maskSecret(this.CERT_APP_TOKEN)} / ${this.CERT_TABLE_ID}`,
    );

    let pageToken: string | undefined;
    const pageSize = 500;
    let hasMore = true;

    do {
      const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.CERT_APP_TOKEN}/tables/${this.CERT_TABLE_ID}/records`;
      const response = await this.httpService.axiosRef.get(apiUrl, {
        headers: { Authorization: 'Bearer ' + tenantAccessToken },
        params: { page_size: pageSize, page_token: pageToken },
        timeout: 30000,
      });

      if (response.data.code !== 0) {
        throw new Error(`飞书 API 错误: ${response.data.msg}`);
      }

      const currentBatch = response.data.data.items || [];
      pageToken = response.data.data.page_token;
      hasMore = response.data.data.has_more;

      for (const item of currentBatch) {
        try {
          const recordId = item.id;
          const fields = item.fields;

          // 提取员工证书信息字段
          const appName = fields ? this.extractTextValue(fields['姓名']) : null;
          const appEmployeeName = fields
            ? this.extractFirstUserId(fields['人员'])
            : null;
          const appEmployeeId = fields
            ? this.extractTextValue(fields['员工工号'])
            : null;
          const employmentType = fields
            ? this.extractTextValue(fields['用工性质'])
            : null;
          const position = fields
            ? this.extractTextValue(fields['岗位'])
            : null;
          const companyName = fields
            ? this.extractTextValue(fields['公司名称'])
            : null;
          const shift = fields ? this.extractTextValue(fields['班次']) : null;
          const buildingProfessional = fields
            ? this.extractMultiSelectValues(fields['机楼/专业'])
            : [];

          const existingRecord = await this.db
            .select()
            .from(appEmployeeCertInfoFormal)
            .where(eq(appEmployeeCertInfoFormal.recordId, recordId))
            .limit(1);

          if (existingRecord.length > 0) {
            await this.db
              .update(appEmployeeCertInfoFormal)
              .set({
                appName: appName ?? existingRecord[0].appName,
                appEmployeeName:
                  appEmployeeName ?? existingRecord[0].appEmployeeName,
                appEmployeeId: appEmployeeId ?? existingRecord[0].appEmployeeId,
                employmentType:
                  employmentType ?? existingRecord[0].employmentType,
                position: position ?? existingRecord[0].position,
                companyName: companyName ?? existingRecord[0].companyName,
                shift: shift ?? existingRecord[0].shift,
                buildingProfessional:
                  buildingProfessional.length > 0
                    ? buildingProfessional
                    : existingRecord[0].buildingProfessional,
              })
              .where(eq(appEmployeeCertInfoFormal.recordId, recordId));
            totalUpdated++;
          } else {
            await this.db.insert(appEmployeeCertInfoFormal).values({
              recordId: recordId,
              appName: appName,
              appEmployeeName: appEmployeeName,
              appEmployeeId: appEmployeeId,
              employmentType: employmentType,
              position: position,
              companyName: companyName,
              shift: shift,
              buildingProfessional:
                buildingProfessional.length > 0 ? buildingProfessional : [],
            });
            totalInserted++;
          }
        } catch (error) {
          totalFailed++;
          this.logger.error(`处理员工证书记录失败: ${item.id}`, error);
        }
      }
    } while (hasMore);

    this.logger.log(
      `员工证书信息表同步完成：新增 ${totalInserted} 条，更新 ${totalUpdated} 条`,
    );
    return {
      inserted: totalInserted,
      updated: totalUpdated,
      failed: totalFailed,
    };
  }

  /**
   * 提取多选字段值
   */
  private extractMultiSelectValues(field: unknown): string[] {
    if (!field) return [];

    // 如果是数组
    if (Array.isArray(field)) {
      return field
        .map((item) => {
          if (typeof item === 'string') return item;
          if (typeof item === 'object' && item !== null && 'text' in item) {
            return String((item as { text: string }).text);
          }
          return String(item);
        })
        .filter(Boolean);
    }

    // 如果是字符串，按逗号分隔
    if (typeof field === 'string') {
      return field
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return [];
  }

  /**
   * 提取用户ID数组
   */
  private extractUserIds(field: unknown): string[] {
    if (!field) return [];

    // 如果是数组（飞书人员字段格式）
    if (Array.isArray(field)) {
      return field
        .map((item) => {
          if (typeof item === 'object' && item !== null) {
            // 格式1: { id: "...", name: "..." }
            if ('id' in item) {
              return String((item as { id: string }).id);
            }
            // 格式2: { text: "...", type: "text" }
            if ('text' in item) {
              return String((item as { text: string }).text);
            }
          }
          if (typeof item === 'string') return item;
          return String(item);
        })
        .filter(Boolean);
    }

    // 如果是字符串（公式字段返回的文本格式，如逗号分隔的用户ID）
    if (typeof field === 'string') {
      // 分割逗号或换行符分隔的字符串
      return field
        .split(/[,，\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    return [];
  }

  /**
   * 提取第一个用户ID（用于 userProfile 类型字段）
   */
  private extractFirstUserId(field: unknown): string | null {
    if (!field) return null;

    // 如果是数组，取第一个元素的 id
    if (Array.isArray(field) && field.length > 0) {
      const firstItem = field[0];
      if (
        typeof firstItem === 'object' &&
        firstItem !== null &&
        'id' in firstItem
      ) {
        return String((firstItem as { id: string }).id);
      }
      if (typeof firstItem === 'string') return firstItem;
    }

    // 如果是对象，直接取 id
    if (typeof field === 'object' && field !== null && 'id' in field) {
      return String((field as { id: string }).id);
    }

    // 如果是字符串，直接返回
    if (typeof field === 'string') return field;

    return null;
  }

  /**
   * 获取组织架构列表
   */
  async getOrganizations() {
    try {
      this.logger.log('获取组织架构列表');

      if (isDatabaseDisabled()) {
        const records = await this.fetchFeishuOrganizationRecords();
        const organizations =
          this.mapFeishuEmployeeRecordsToOrganizations(records);
        this.logger.log(`飞书直读在职人员组织架构: ${organizations.length} 条`);
        return { organizations };
      }

      const organizations = await this.db
        .select({
          id: nantongOrganization.id,
          recordId: nantongOrganization.recordId,
          code: nantongOrganization.code,
          position: nantongOrganization.position,
          buildingsSpecialties: nantongOrganization.buildingsSpecialties,
          supervisor: nantongOrganization.supervisor,
          dutyAccount: nantongOrganization.dutyAccount,
          supervisorText: nantongOrganization.supervisorText,
          parentRecord: nantongOrganization.parentRecord,
          createdAt: nantongOrganization.createdAt,
          updatedAt: nantongOrganization.updatedAt,
        })
        .from(nantongOrganization)
        .orderBy(nantongOrganization.position);

      this.logger.log(`获取到 ${organizations.length} 条组织架构记录`);

      return {
        organizations: organizations.map((org) => ({
          ...org,
          createdAt: org.createdAt?.toISOString?.() || String(org.createdAt),
          updatedAt: org.updatedAt?.toISOString?.() || String(org.updatedAt),
        })),
      };
    } catch (error) {
      this.logger.error('获取组织架构列表失败', error);
      throw error;
    }
  }

  /**
   * 获取人员资料列表，用于排班页姓名弹窗。
   */
  async getPersonProfiles(
    forceRefresh = false,
    scope: PersonProfileScope = 'leave',
  ): Promise<PersonProfileResponse> {
    try {
      this.logger.log(`获取人员资料列表: ${scope}`);
      const records = forceRefresh
        ? await this.fetchFeishuPersonProfileRecords(true, scope)
        : await this.readCachedPersonProfileRecords(scope, false);
      const organizations =
        this.mapFeishuEmployeeRecordsToPersonProfiles(records);
      this.logger.debug(
        `${forceRefresh ? '飞书刷新' : '本地缓存读取'}人员资料(${scope}): ${organizations.length} 条`,
      );
      return {
        organizations,
        changeRequestSubmitters:
          scope === 'leave'
            ? listEligibleChangeRequestSubmitterNames(records)
            : [],
      };
    } catch (error) {
      this.logger.error(
        `获取飞书人员资料失败(${scope}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException('人员资料加载失败，请稍后重试');
    }
  }

  /**
   * 按稳定来源标识读取单个人员档案。非强制刷新，优先复用在职人员缓存。
   */
  async getOrganizationPersonProfile(
    source: OrganizationPersonProfileSource,
    sourceRecordId: string,
  ): Promise<OrganizationPersonProfileResponse> {
    const normalizedRecordId = String(sourceRecordId || '').trim();
    if (!/^[a-z0-9_-]{1,128}$/iu.test(normalizedRecordId)) {
      throw new NotFoundException('人员档案不存在');
    }

    const [records, qualityIssueSnapshot] = await Promise.all([
      this.fetchFeishuOrganizationRecords(),
      readLatestPersistedBitableRecordSnapshot({
        tableId: ALI_MONTHLY_QUALITY_ISSUE_TABLE_ID,
        viewId: ALI_MONTHLY_QUALITY_ISSUE_VIEW_ID,
        tableName: '阿里月度质量检查清单',
      }),
    ]);
    let organizationRecord: BitableRecordItem | undefined;

    if (source === 'organization') {
      organizationRecord = records.find(
        (record) => getRecordId(record) === normalizedRecordId,
      );
    } else if (!isDatabaseDisabled()) {
      const certificateRecords = await this.db
        .select({
          appEmployeeName: appEmployeeCertInfoFormal.appEmployeeName,
        })
        .from(appEmployeeCertInfoFormal)
        .where(eq(appEmployeeCertInfoFormal.id, normalizedRecordId))
        .limit(1);
      const openId = extractFeishuOpenId(
        certificateRecords[0]?.appEmployeeName,
      );
      if (openId) {
        organizationRecord = records.find((record) => {
          const fields = record.fields ?? {};
          return (
            extractFeishuOpenId(
              pickField(fields, ['员工姓名', '员工', '人员']),
            ) === openId
          );
        });
      }
    }

    const profile = organizationRecord
      ? mapOrganizationPersonProfileRecord(organizationRecord)
      : null;
    if (!profile) {
      throw new NotFoundException('人员档案不存在或在职人员缓存尚未同步');
    }
    return {
      profile: {
        ...profile,
        qualityAssessment: buildOrganizationPersonQualityAssessment(
          profile.recordId,
          qualityIssueSnapshot,
          records,
        ),
      },
    };
  }

  /**
   * 读取后台同步到本地的在职人员快照，业务请求不直连飞书多维表。
   */
  async getCachedActivePersonnelDirectory(): Promise<ActivePersonnelDirectory> {
    const snapshot = await readLatestPersistedBitableRecordSnapshot({
      appToken: this.ORG_APP_TOKEN || undefined,
      tableId: this.ORG_TABLE_ID,
      viewId: this.ORG_VIEW_ID || undefined,
      tableName: '在职人员',
    });
    if (!snapshot) {
      this.logger.warn('在职人员本地缓存尚未就绪');
      throw new ServiceUnavailableException(
        '在职人员本地缓存暂不可用，请等待后台同步',
      );
    }
    return buildActivePersonnelDirectory(snapshot);
  }

  async syncApprovedLeaveScheduleSnapshot(
    assignments: ApprovedLeaveScheduleSyncAssignment[],
    approvalScope?: ApprovedLeaveScheduleSyncScope,
  ): Promise<{ nonDutyRecords: number; scheduleRecords: number }> {
    const expectedByRecordId = new Map<string, Set<string>>();
    const primaryRecordIds = new Set<string>();
    const originalPostExpected = new Map<string, { primary: string; backup: string }>();
    const releasedExpected = new Map<string, Set<string>>();
    for (const assignment of assignments) {
      const substituteName = String(assignment.substituteName || '').trim();
      const recordIds = Array.from(
        new Set(
          (assignment.scheduleRecordIds || [])
            .map((recordId) => String(recordId || '').trim())
            .filter(Boolean),
        ),
      );
      if (!assignment.shiftKey || !substituteName || recordIds.length === 0) {
        throw new ServiceUnavailableException(
          '请休假审批后排班同步参数不完整 (readback mismatch)',
        );
      }
      for (const recordId of recordIds) {
        primaryRecordIds.add(recordId);
        const expectedNames =
          expectedByRecordId.get(recordId) || new Set<string>();
        expectedNames.add(substituteName);
        expectedByRecordId.set(recordId, expectedNames);
      }
      for (const backup of assignment.originalPostBackfills || []) {
        if (!backup.substituteName || !backup.substituteOpenId || !backup.substitutePersonRecordId || !backup.group?.scheduleRecordIds?.length || backup.substituteName === substituteName) throw new ServiceUnavailableException('原岗补位同步参数不完整');
        for (const recordId of backup.group.scheduleRecordIds) {
          const previous = originalPostExpected.get(recordId);
          if (previous && (previous.primary !== substituteName || previous.backup !== backup.substituteName)) throw new ServiceUnavailableException('原岗补位同步安排冲突');
          originalPostExpected.set(recordId, { primary: substituteName, backup: backup.substituteName });
          const names = expectedByRecordId.get(recordId) || new Set<string>();
          names.add(backup.substituteName); expectedByRecordId.set(recordId, names);
        }
      }
    }
    if ([...originalPostExpected.keys()].some((recordId) => primaryRecordIds.has(recordId))) throw new ServiceUnavailableException('原岗与请假岗位同步范围冲突');
    for (const released of approvalScope?.releasedOriginalPosts || []) {
      if (!released.previousPrimaryName || !released.previousBackupName || !released.scheduleRecordIds?.length) throw new ServiceUnavailableException('原岗恢复同步参数不完整');
      for (const recordId of released.scheduleRecordIds) {
        if (primaryRecordIds.has(recordId) || originalPostExpected.has(recordId)) continue;
        const names = releasedExpected.get(recordId) || new Set<string>();
        names.add(released.previousPrimaryName); releasedExpected.set(recordId, names);
        expectedByRecordId.set(recordId, names);
      }
    }
    const applicantName = String(approvalScope?.applicantName || '').trim();
    const substituteName = String(approvalScope?.substituteName || '').trim();
    const toShanghaiDateKey = (value: unknown): string => {
      const parsed = new Date(String(value || ''));
      return Number.isFinite(parsed.getTime())
        ? this.getShanghaiDateKeyAndHour(parsed).dateKey
        : '';
    };
    const startDate = toShanghaiDateKey(approvalScope?.startAt);
    const endDate = toShanghaiDateKey(approvalScope?.endAt);
    const hasValidApprovalScope =
      Boolean(applicantName) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(startDate) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(endDate) &&
      endDate >= startDate;
    if (approvalScope && !hasValidApprovalScope) {
      throw new ServiceUnavailableException(
        '请休假审批后排班同步范围无效 (readback mismatch)',
      );
    }
    if (expectedByRecordId.size === 0 && !hasValidApprovalScope) {
      throw new ServiceUnavailableException(
        '请休假审批后没有可校验的排班范围 (readback mismatch)',
      );
    }

    const [nonDutyRecords, scheduleRecords] = await Promise.all([
      this.fetchFeishuNonDutyRecords(true, true),
      this.fetchFeishuScheduleRecords(true, true),
    ]);
    for (const [recordId, expected] of originalPostExpected) {
      const record = [...nonDutyRecords, ...scheduleRecords].find((row) => getRecordId(row) === recordId);
      const replacements = record?.fields?.[SYSTEM_APPROVED_POST_REPLACEMENTS_FIELD];
      if (!record || !Array.isArray(replacements) || !replacements.some((row: { removedStaff?: string; addedStaff?: string }) => row.removedStaff === expected.primary && row.addedStaff === expected.backup)) throw new ServiceUnavailableException(`原岗补位明细未生效，暂不写回排班: ${recordId}`);
    }
    for (const [recordId, expected] of releasedExpected) {
      const record = [...nonDutyRecords, ...scheduleRecords].find((row) => getRecordId(row) === recordId);
      const planned = new Set(extractDisplayValues(pickField(record?.fields || {}, ['fldJi5bxBG', '人员（文本）', '人员文本', '人员', '长白班'])).flatMap((name) => this.splitStaffNames(name)));
      if (!record || [...expected].some((name) => !planned.has(name))) throw new ServiceUnavailableException(`原岗计划已变化，暂不恢复排班: ${recordId}`);
    }
    const isInApprovalScope = (record: BitableRecordItem): boolean => {
      if (!hasValidApprovalScope) return false;
      const fields = record.fields || {};
      const scheduleDate = extractFeishuDateValue(
        pickField(fields, [
          'fldZSaDbGf',
          'schedule_date',
          '\u6392\u73ed\u65e5\u671f',
          '\u65e5\u671f',
        ]),
      );
      const leaveStaff = extractDisplayValues(
        pickField(fields, [SYSTEM_APPROVED_LEAVE_STAFF_FIELD]),
      ).flatMap((name) => this.splitStaffNames(name));
      return (
        Boolean(scheduleDate) &&
        scheduleDate! >= startDate &&
        scheduleDate! <= endDate &&
        leaveStaff.includes(applicantName)
      );
    };
    const affectedRecordIds = new Set(expectedByRecordId.keys());
    if (affectedRecordIds.size === 0) {
      [...nonDutyRecords, ...scheduleRecords]
        .filter(isInApprovalScope)
        .map(getRecordId)
        .filter(Boolean)
        .forEach((recordId) => affectedRecordIds.add(recordId));
    }
    const expectedActualStaffByRecordId =
      await this.syncApprovedLeaveActualStaff({
        nonDutyRecords,
        scheduleRecords,
        affectedRecordIds,
      });
    const [verifiedNonDutyRecords, verifiedScheduleRecords] =
      expectedActualStaffByRecordId.updated
        ? await Promise.all([
            this.fetchFeishuNonDutyRecords(true, true),
            this.fetchFeishuScheduleRecords(true, true),
          ])
        : [nonDutyRecords, scheduleRecords];
    const refreshedRecords = new Map<string, BitableRecordItem>();
    for (const record of [
      ...verifiedNonDutyRecords,
      ...verifiedScheduleRecords,
    ]) {
      const recordId = getRecordId(record);
      if (recordId) refreshedRecords.set(recordId, record);
    }

    for (const [recordId, expectedNames] of expectedByRecordId) {
      const record = refreshedRecords.get(recordId);
      const actualLeaveStaff = new Set(
        extractDisplayValues(
          pickField(record?.fields || {}, [SYSTEM_APPROVED_LEAVE_STAFF_FIELD]),
        ).flatMap((name) => this.splitStaffNames(name)),
      );
      const actualNames = new Set(
        extractDisplayValues(
          pickField(record?.fields || {}, [
            SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
          ]),
        ).flatMap((name) => this.splitStaffNames(name)),
      );
      if (originalPostExpected.has(recordId)) {
        const replacements = record?.fields?.[SYSTEM_APPROVED_POST_REPLACEMENTS_FIELD];
        if (Array.isArray(replacements)) for (const row of replacements) if (typeof row?.addedStaff === 'string') actualNames.add(row.addedStaff);
      }
      const actualDutyStaff = new Set(
        extractDisplayValues(
          pickDutyStaffActualField(record?.fields || {}),
        ).flatMap((name) => this.splitStaffNames(name)),
      );
      const expectedActualStaff =
        expectedActualStaffByRecordId.names.get(recordId);
      if (
        !record ||
        Array.from(expectedNames).some((name) => releasedExpected.has(recordId) ? !actualDutyStaff.has(name) : !actualNames.has(name)) ||
        (hasValidApprovalScope && !originalPostExpected.has(recordId) && !releasedExpected.has(recordId) && !actualLeaveStaff.has(applicantName)) ||
        (expectedActualStaff &&
          !sameStringSet(actualDutyStaff, expectedActualStaff))
      ) {
        throw new ServiceUnavailableException(
          `请休假审批后排班回读不一致 (readback mismatch): ${recordId}`,
        );
      }
    }

    if (expectedByRecordId.size === 0) {
      const scopedRecords = [
        ...verifiedNonDutyRecords,
        ...verifiedScheduleRecords,
      ].filter(isInApprovalScope);
      if (
        scopedRecords.length === 0 ||
        (Boolean(substituteName) &&
          scopedRecords.some((record) => {
            const substitutes = extractDisplayValues(
              pickField(record.fields || {}, [
                SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
              ]),
            ).flatMap((name) => this.splitStaffNames(name));
            return !substitutes.includes(substituteName);
          }))
      ) {
        throw new ServiceUnavailableException(
          '请休假审批后排班回读不一致 (readback mismatch): approval scope',
        );
      }
    }

    return {
      nonDutyRecords: verifiedNonDutyRecords.length,
      scheduleRecords: verifiedScheduleRecords.length,
    };
  }

  private async syncApprovedLeaveActualStaff(input: {
    nonDutyRecords: BitableRecordItem[];
    scheduleRecords: BitableRecordItem[];
    affectedRecordIds: Set<string>;
  }): Promise<{ updated: boolean; names: Map<string, Set<string>> }> {
    const names = new Map<string, Set<string>>();
    const planSource = (
      records: BitableRecordItem[],
      appToken: string,
      tableId: string,
    ) => {
      const updates: Array<{
        record_id: string;
        fields: Record<string, unknown>;
      }> = [];
      for (const record of records) {
        const recordId = getRecordId(record);
        if (!recordId || !input.affectedRecordIds.has(recordId)) continue;
        const fields = record.fields || {};
        const plannedStaff = extractDisplayValues(
          pickField(fields, [
            'fldJi5bxBG',
            '人员（文本）',
            '人员文本',
            '人员',
            '长白班',
          ]),
        ).flatMap((name) => this.splitStaffNames(name));
        const currentStaff = extractDisplayValues(
          pickDutyStaffActualField(fields),
        ).flatMap((name) => this.splitStaffNames(name));
        if (plannedStaff.length === 0 && currentStaff.length === 0) continue;

        const refresh = buildDutyProgramModifiedRefreshItem({
          recordId,
          plannedStaff,
          leaveStaff: extractDisplayValues(
            pickField(fields, [SYSTEM_APPROVED_LEAVE_STAFF_FIELD]),
          ).flatMap((name) => this.splitStaffNames(name)),
          substituteStaff: extractDisplayValues(
            pickField(fields, [SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]),
          ).flatMap((name) => this.splitStaffNames(name)),
          vacancySubstituteStaff: extractDisplayValues(
            pickField(fields, [
              '缺岗替班',
              '缺岗替班人员',
              '缺岗替代',
              '缺岗人员替班',
            ]),
          ).flatMap((name) => this.splitStaffNames(name)),
          travelStaff: extractDisplayValues(
            pickField(fields, ['差旅人员', '出差人员', '差旅', '差旅人员信息']),
          ).flatMap((name) => this.splitStaffNames(name)),
        });
        const replacements = fields[SYSTEM_APPROVED_POST_REPLACEMENTS_FIELD];
        const finalText = Array.isArray(replacements) && replacements.length
          ? resolveApprovalAwareDutyStaffFromFields(fields).dutyStaff.join('、')
          : refresh.finalText;
        const expectedNames = new Set(this.splitStaffNames(finalText));
        names.set(recordId, expectedNames);
        if (sameStringSet(new Set(currentStaff), expectedNames)) continue;

        const fieldName = DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES.find(
          (candidate) =>
            Object.prototype.hasOwnProperty.call(fields, candidate),
        );
        if (!fieldName) {
          throw new ServiceUnavailableException(
            `请休假审批后排班缺少实际人员可写字段: ${recordId}`,
          );
        }
        updates.push({
          record_id: recordId,
          fields: { [fieldName]: finalText },
        });
      }
      return { appToken, tableId, updates };
    };

    const sources = [
      planSource(
        input.nonDutyRecords,
        this.NON_DUTY_APP_TOKEN,
        this.NON_DUTY_TABLE_ID,
      ),
      planSource(
        input.scheduleRecords,
        this.SCHEDULE_APP_TOKEN,
        this.SCHEDULE_TABLE_ID,
      ),
    ].filter((source) => source.updates.length > 0);
    if (sources.length === 0) return { updated: false, names };

    const tenantAccessToken = await this.getTenantAccessToken();
    await Promise.all(
      sources.map(async (source) => {
        assertBitableTableConfig(
          '请休假审批后排班同步',
          source.appToken,
          source.tableId,
        );
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${source.appToken}/tables/${source.tableId}/records/batch_update`;
        for (const records of chunkBitableRecordUpdates(source.updates)) {
          const response = await this.httpService.axiosRef.post(
            url,
            { records },
            {
              headers: { Authorization: `Bearer ${tenantAccessToken}` },
              timeout: 30000,
            },
          );
          if (response.data?.code !== 0) {
            throw new ServiceUnavailableException(
              `请休假审批后更新实际排班失败: ${String(response.data?.msg || response.data?.code || 'unknown')}`,
            );
          }
        }
        invalidateBitableRecordCache({
          appToken: source.appToken,
          tableId: source.tableId,
        });
      }),
    );
    return { updated: true, names };
  }

  /**
   * 卡片资格校验只读后台保存的快照，不能在受理前触发云端刷新。
   */
  async getCachedLeaveRequestImpactSchedules(
    startDate: string,
    endDate: string,
  ): Promise<LeaveRequestImpactSchedule[]> {
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(endDate) ||
      endDate < startDate
    ) {
      throw new ServiceUnavailableException('请休假替班排班日期范围无效');
    }
    const [nonDutySnapshot, scheduleSnapshot, approvalState] = await Promise.all([
      readLatestPersistedBitableRecordSnapshot({
        appToken: this.NON_DUTY_APP_TOKEN || undefined,
        tableId: this.NON_DUTY_TABLE_ID,
        tableName: '长白班排班',
      }),
      readLatestPersistedBitableRecordSnapshot({
        appToken: this.SCHEDULE_APP_TOKEN || undefined,
        tableId: this.SCHEDULE_TABLE_ID,
        tableName: '值班排班',
      }),
      readCachedLeaveApprovalSnapshotState(),
    ]);
    if (!nonDutySnapshot || !scheduleSnapshot) {
      throw new ServiceUnavailableException('排班本地缓存暂不可用，请等待后台同步后重试');
    }
    if (!approvalState.snapshot.verified) {
      throw new ServiceUnavailableException('请休假审批本地缓存缺失或已过期，请等待后台同步后重试');
    }
    const inRange = (date: string | null): date is string =>
      Boolean(date && date >= startDate && date <= endDate);
    // The caller includes adjacent rest days; unrelated historical rows need no approval projection.
    const nonDutyRecords = enrichScheduleRecordsWithLeaveApproval(
      nonDutySnapshot.records.filter(record => inRange(extractFeishuDateValue(
        pickField(record.fields || {}, ['排班日期', '日期', 'schedule_date']),
      ))),
      approvalState.snapshot,
    );
    const scheduleRecords = enrichScheduleRecordsWithLeaveApproval(
      scheduleSnapshot.records.filter(record => inRange(extractFeishuDateValue(
        pickField(record.fields || {}, ['fldZSaDbGf', '排班日期', '日期']),
      ))),
      approvalState.snapshot,
    );
    const result: LeaveRequestImpactSchedule[] = [];

    for (const record of nonDutyRecords) {
      const schedule = this.mapFeishuNonDutyRecord(record);
      if (!schedule || !inRange(schedule.scheduleDate)) continue;
      result.push({
        recordId: schedule.recordId,
        scheduleDate: schedule.scheduleDate,
        building: schedule.building || undefined,
        buildingText: schedule.building || undefined,
        team: schedule.team || '长白',
        teamText: schedule.team || '长白',
        shift: 'long_white',
        shiftText: '长白',
        dutyStaffActual: this.splitStaffNames(schedule.dutyStaffActual),
      });
    }

    for (const record of scheduleRecords) {
      const fields = record.fields || {};
      const scheduleDate = extractFeishuDateValue(
        pickField(fields, ['fldZSaDbGf', '排班日期', '日期']),
      );
      if (!inRange(scheduleDate)) continue;
      const buildingText = extractDisplayText(
        pickField(fields, ['fldnP4gXMn', '机楼', '楼栋', '值守机楼']),
      );
      const teamText = extractDisplayText(
        pickField(fields, ['fldE9Gwnk7', '班组', '班别']),
      );
      const shiftText = extractDisplayText(
        pickField(fields, ['fldqPpOgW5', '班次', '值班班次']),
      );
      const approvedLeave = resolveApprovalAwareDutyStaffFromFields(fields);
      result.push({
        recordId: getRecordId(record),
        scheduleDate,
        building: normalizeBuildingForFrontend(buildingText),
        buildingText,
        team: normalizeTeamForFrontend(teamText),
        teamText,
        shift: shiftText,
        shiftText,
        dutyStaffActual: approvedLeave.dutyStaff,
      });
    }

    return result.sort(
      (left, right) =>
        String(left.scheduleDate || '').localeCompare(
          String(right.scheduleDate || ''),
        ) || left.recordId.localeCompare(right.recordId),
    );
  }

  /**
   * 获取排班页人员私密资料，仅供控制器授权后的身份使用。
   */
  async getPersonProfileDetails(
    forceRefresh = false,
    scope: PersonProfileScope = 'leave',
  ): Promise<PersonProfileDetailResponse> {
    try {
      const records = forceRefresh
        ? await this.fetchFeishuPersonProfileRecords(true, scope, true)
        : await this.readCachedPersonProfileRecords(scope, true);
      return {
        organizations: this.mapFeishuEmployeeRecordsToPersonProfileDetails(
          records,
          scope,
        ),
      };
    } catch (error) {
      this.logger.error(
        `获取飞书人员私密资料失败(${scope}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException('人员详细资料加载失败，请稍后重试');
    }
  }

  /**
   * 仅从服务器本地快照解析飞书身份，避免点击姓名时实时请求多维表。
   */
  async getPersonChatAppLink(
    recordId: string,
    scope: PersonProfileScope = 'leave',
  ): Promise<string | null> {
    const normalizedRecordId = decodeURIComponent(recordId);
    try {
      const records = await this.readCachedPersonProfileRecords(scope, true);
      const record = records.find(
        (item) => getRecordId(item) === normalizedRecordId,
      );
      if (!record?.fields) {
        return null;
      }

      let openId = extractFeishuOpenId(
        pickField(record.fields, ['员工姓名', '员工', '人员']),
      );
      if (!openId) {
        const profile = this.mapFeishuEmployeeRecordToPersonProfile(record);
        const normalizedName = String(profile?.supervisorText || '')
          .replace(/\s+/g, '')
          .trim();
        if (normalizedName) {
          try {
            const directory = await this.getCachedActivePersonnelDirectory();
            const matches = directory.personnel.filter(
              (person) =>
                person.name.replace(/\s+/g, '').trim() === normalizedName,
            );
            if (matches.length === 1) {
              openId = matches[0].openId;
            }
          } catch (error) {
            this.logger.warn(
              `飞书会话本地人员目录回退不可用: ${normalizedRecordId} ${(error as Error).message}`,
            );
          }
        }
      }

      return buildFeishuChatAppLink(openId);
    } catch (error) {
      this.logger.warn(
        `解析员工飞书会话失败: ${normalizedRecordId} ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * 从飞书多维表同步节日重要/重保人员排班数据。
   */
  async syncFestivalImportantSchedule() {
    try {
      const records = await this.fetchFeishuFestivalImportantRecords(true);
      const schedules = records
        .map((record) => this.mapFeishuFestivalImportantRecord(record))
        .filter((schedule): schedule is FestivalSchedule => Boolean(schedule));

      if (isDatabaseDisabled()) {
        return {
          success: true,
          total: schedules.length,
          inserted: 0,
          updated: 0,
          failed: 0,
          message: `本地数据库未启用，已切换为飞书直读模式（节日重保排班 ${schedules.length} 条）`,
        };
      }

      await this.db.delete(appFestivalImportantSchedule);
      if (schedules.length > 0) {
        await this.db.insert(appFestivalImportantSchedule).values(
          schedules.map((schedule) => ({
            recordId: schedule.recordId,
            appShiftId: schedule.appShiftId,
            appCode: schedule.appCode,
            appScheduleDate: schedule.appScheduleDate || null,
            appHeavyType: schedule.appHeavyType,
            appScheduleDateWeek: schedule.appScheduleDateWeek,
            appYearWeek: schedule.appYearWeek,
            appDutyBuilding: schedule.appDutyBuilding,
            appDutyStaff: schedule.appDutyStaff || [],
            appStaffText: schedule.appStaffText,
          })),
        );
      }

      return {
        success: true,
        total: schedules.length,
        inserted: schedules.length,
        updated: 0,
        failed: 0,
        message: `节日重保排班已同步 ${schedules.length} 条`,
      };
    } catch (error) {
      this.logger.error('同步节日重保排班数据失败', error);
      throw error;
    }
  }

  /**
   * 从飞书多维表格同步节日&重保排班数据
   */
  async syncHolidayDutySchedule() {
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalFailed = 0;

    try {
      this.logger.log('开始从飞书多维表格同步节日&重保排班数据');
      assertBitableTableConfig(
        '节日&重保排班',
        this.HOLIDAY_APP_TOKEN,
        this.HOLIDAY_TABLE_ID,
      );

      const tenantAccessToken = await this.getTenantAccessToken();
      this.logger.log('获取 tenant_access_token 成功');

      let pageToken: string | undefined;
      const pageSize = 500;
      let hasMore = true;
      let pageCount = 0;

      do {
        pageCount++;
        const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.HOLIDAY_APP_TOKEN}/tables/${this.HOLIDAY_TABLE_ID}/records`;
        const response = await this.httpService.axiosRef.get(apiUrl, {
          headers: { Authorization: 'Bearer ' + tenantAccessToken },
          params: { page_size: pageSize, page_token: pageToken },
          timeout: 30000,
        });

        if (response.data.code !== 0) {
          throw new Error(`飞书 API 错误: ${response.data.msg}`);
        }

        const currentBatch = response.data.data.items || [];
        pageToken = response.data.data.page_token;
        hasMore = response.data.data.has_more;

        for (const item of currentBatch) {
          try {
            const recordId = item.id;
            const fields = item.fields;

            const dutyCode = fields
              ? this.extractTextValue(fields['值班编号'])
              : null;
            const code = fields
              ? this.extractNumberValue(fields['编码'])
              : null;
            const scheduleDate = fields
              ? this.extractDateValue(fields['排班日期'])
              : null;
            const dutyType = fields
              ? this.extractTextValue(fields['重保类型'])
              : null;
            const scheduleWeekday = fields
              ? this.extractTextValue(fields['排班日期（星期）'])
              : null;
            const weekNumber = fields
              ? this.extractNumberValue(fields['年度周数'])
              : null;
            const building = fields
              ? this.extractTextValue(fields['值守机楼'])
              : null;
            const dutyStaff = fields
              ? this.extractFirstUserId(fields['值班人员'])
              : null;
            const dutyStaffText = fields
              ? this.extractTextValue(fields['人员（文本）'])
              : null;

            // 检查记录是否已存在
            const existingRecord = await this.db
              .select()
              .from(holidayDutySchedule)
              .where(eq(holidayDutySchedule.recordId, recordId))
              .limit(1);

            if (existingRecord.length > 0) {
              await this.db
                .update(holidayDutySchedule)
                .set({
                  dutyCode: dutyCode ?? existingRecord[0].dutyCode,
                  code: code ?? existingRecord[0].code,
                  scheduleDate: scheduleDate
                    ? scheduleDate
                    : existingRecord[0].scheduleDate,
                  dutyType: dutyType ?? existingRecord[0].dutyType,
                  scheduleWeekday:
                    scheduleWeekday ?? existingRecord[0].scheduleWeekday,
                  weekNumber: weekNumber ?? existingRecord[0].weekNumber,
                  building: building ?? existingRecord[0].building,
                  dutyStaff: dutyStaff ?? existingRecord[0].dutyStaff,
                  dutyStaffText:
                    dutyStaffText ?? existingRecord[0].dutyStaffText,
                })
                .where(eq(holidayDutySchedule.recordId, recordId));
              totalUpdated++;
            } else {
              await this.db.insert(holidayDutySchedule).values({
                recordId: recordId,
                dutyCode: dutyCode,
                code: code,
                scheduleDate:
                  scheduleDate || new Date().toISOString().split('T')[0],
                dutyType: dutyType || '其他',
                scheduleWeekday: scheduleWeekday,
                weekNumber: weekNumber,
                building: building || '',
                dutyStaff: dutyStaff || '',
                dutyStaffText: dutyStaffText,
              });
              totalInserted++;
            }
          } catch (error) {
            totalFailed++;
            this.logger.error(`处理节日&重保排班记录失败: ${item.id}`, error);
          }
        }
      } while (hasMore);

      this.logger.log(
        `节日&重保排班表同步完成：新增 ${totalInserted} 条，更新 ${totalUpdated} 条`,
      );
      return {
        success: true,
        inserted: totalInserted,
        updated: totalUpdated,
        failed: totalFailed,
      };
    } catch (error) {
      this.logger.error('同步节日&重保排班数据失败', error);
      throw error;
    }
  }

  /**
   * 从飞书多维表格同步非值班排班数据
   */
  async syncNonDutySchedule() {
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalFailed = 0;

    try {
      if (isDatabaseDisabled()) {
        const records = await this.fetchFeishuNonDutyRecords(true);
        return {
          success: true,
          total: records.length,
          inserted: 0,
          updated: 0,
          failed: 0,
          message: `本地数据库未启用，已切换为飞书直读模式（长白班表 ${records.length} 条）`,
        };
      }

      this.logger.log('开始从飞书多维表格同步非值班排班数据');
      assertBitableTableConfig(
        '非值班排班',
        this.NON_DUTY_APP_TOKEN,
        this.NON_DUTY_TABLE_ID,
      );

      // 先清空原有数据
      this.logger.log('清空 non_duty_schedule 表中的原有数据');
      await this.db.delete(nonDutySchedule);
      this.logger.log('清空完成，开始同步新数据');

      const tenantAccessToken = await this.getTenantAccessToken();
      this.logger.log('获取 tenant_access_token 成功');

      let pageToken: string | undefined;
      const pageSize = 500;
      let hasMore = true;
      let pageCount = 0;

      do {
        pageCount++;
        const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.NON_DUTY_APP_TOKEN}/tables/${this.NON_DUTY_TABLE_ID}/records`;
        const response = await this.httpService.axiosRef.get(apiUrl, {
          headers: { Authorization: 'Bearer ' + tenantAccessToken },
          params: {
            page_size: pageSize,
            page_token: pageToken,
            field_names: JSON.stringify([
              '值班编码',
              '编码',
              '排班日期',
              '机楼',
              '班组',
              '人员（文本）',
              '值班人员（实际）程序修改',
              '值班人员（实际）',
              '请假人员',
              '请假人员（请假表）',
              '请假人员(辅助)',
              '替班人员',
              '最新更新时间',
            ]),
          },
          timeout: 30000,
        });

        if (response.data.code !== 0) {
          throw new Error(`飞书 API 错误: ${response.data.msg}`);
        }

        const currentBatch = response.data.data.items || [];
        pageToken = response.data.data.page_token;
        hasMore = response.data.data.has_more;

        for (const item of currentBatch) {
          try {
            const recordId = item.id;
            const fields = item.fields;

            const dutyCode = fields
              ? this.extractTextValue(fields['值班编码'])
              : null;
            const code = fields
              ? this.extractNumberValue(fields['编码'])
              : null;

            const scheduleDate = fields
              ? this.extractDateValue(fields['排班日期'])
              : null;

            const building = fields
              ? this.extractTextValue(fields['机楼'])
              : null;
            const team = fields ? this.extractTextValue(fields['班组']) : null;
            const personText = fields
              ? this.extractTextValue(fields['人员（文本）'])
              : null;
            const approvedLeave = resolveApprovalAwareDutyStaffFromFields(
              fields || {},
            );
            const dutyStaffActual = approvedLeave.dutyStaff.join(' ');
            const leaveStaff = approvedLeave.leaveStaff.join(' ');
            const leaveStaffBitable = approvedLeave.leaveStaff;
            const substituteStaffBitable = approvedLeave.substituteStaff;

            const lastModifiedTime = fields
              ? this.extractDateTimeValue(fields['最新更新时间'])
              : null;

            // 检查记录是否已存在
            const existingRecord = await this.db
              .select()
              .from(nonDutySchedule)
              .where(eq(nonDutySchedule.recordId, recordId))
              .limit(1);

            if (existingRecord.length > 0) {
              await this.db
                .update(nonDutySchedule)
                .set({
                  dutyCode: dutyCode ?? existingRecord[0].dutyCode,
                  code: code ?? existingRecord[0].code,
                  scheduleDate: scheduleDate
                    ? scheduleDate
                    : existingRecord[0].scheduleDate,
                  building: building ?? existingRecord[0].building,
                  team: team ?? existingRecord[0].team,
                  personText: personText ?? existingRecord[0].personText,
                  dutyStaffActual:
                    dutyStaffActual ?? existingRecord[0].dutyStaffActual,
                  leaveStaff,
                  leaveStaffBitable,
                  substituteStaffBitable,
                  lastModifiedTime:
                    lastModifiedTime ?? existingRecord[0].lastModifiedTime,
                })
                .where(eq(nonDutySchedule.recordId, recordId));
              totalUpdated++;
            } else {
              await this.db.insert(nonDutySchedule).values({
                recordId: recordId,
                dutyCode: dutyCode,
                code: code,
                scheduleDate:
                  scheduleDate || new Date().toISOString().split('T')[0],
                building: building || '',
                team: team || '',
                personText: personText,
                dutyStaffActual: dutyStaffActual,
                leaveStaff: leaveStaff,
                leaveStaffBitable: leaveStaffBitable,
                substituteStaffBitable: substituteStaffBitable,
                lastModifiedTime: lastModifiedTime,
              });
              totalInserted++;
            }
          } catch (error) {
            totalFailed++;
            this.logger.error(`处理非值班排班记录失败: ${item.id}`, error);
          }
        }
      } while (hasMore);

      this.logger.log(
        `非值班排班表同步完成：新增 ${totalInserted} 条，更新 ${totalUpdated} 条`,
      );
      return {
        success: true,
        inserted: totalInserted,
        updated: totalUpdated,
        failed: totalFailed,
      };
    } catch (error) {
      this.logger.error('同步非值班排班数据失败', error);
      throw error;
    }
  }

  /**
   * 提取数字值
   */
  private extractNumberValue(field: unknown): number | null {
    if (typeof field === 'number') {
      return field;
    }
    if (typeof field === 'string') {
      const num = parseInt(field, 10);
      return isNaN(num) ? null : num;
    }
    return null;
  }

  /**
   * 提取日期值（飞书日期格式）
   */
  private extractDateValue(field: unknown): string | null {
    if (!field) return null;

    // 飞书日期字段格式1: { text: "2026-02-04", type: "text" }
    if (typeof field === 'object' && field !== null) {
      const obj = field as { text?: string; type?: string };
      if (obj.text) {
        return obj.text;
      }
    }

    // 飞书日期字段格式2: 时间戳（毫秒），如 1769616000000
    if (typeof field === 'number') {
      const date = new Date(field);
      // 使用本地时间而不是 UTC 时间
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // 如果是字符串
    if (typeof field === 'string') {
      return field;
    }

    return null;
  }

  /**
   * 提取日期时间值（飞书 ModifiedTime 格式）
   */
  private extractDateTimeValue(field: unknown): Date | null {
    if (!field) return null;

    // 飞书 ModifiedTime 字段格式: 时间戳（毫秒）
    if (typeof field === 'number') {
      return new Date(field);
    }

    // 如果是字符串
    if (typeof field === 'string') {
      const timestamp = parseInt(field, 10);
      if (!isNaN(timestamp)) {
        return new Date(timestamp);
      }
      return new Date(field);
    }

    return null;
  }

  /**
   * 获取节日&重保排班列表
   */
  async getHolidayDutySchedules(
    params: { startDate?: string; endDate?: string; dutyType?: string } = {},
  ) {
    try {
      this.logger.log('获取节日&重保排班列表');

      const conditions = [];
      if (params.startDate) {
        conditions.push(
          sql`${holidayDutySchedule.scheduleDate} >= ${params.startDate}`,
        );
      }
      if (params.endDate) {
        conditions.push(
          sql`${holidayDutySchedule.scheduleDate} <= ${params.endDate}`,
        );
      }
      if (params.dutyType) {
        conditions.push(eq(holidayDutySchedule.dutyType, params.dutyType));
      }

      const query =
        conditions.length > 0
          ? this.db
              .select()
              .from(holidayDutySchedule)
              .where(and(...conditions))
          : this.db.select().from(holidayDutySchedule);

      const schedules = await query.orderBy(holidayDutySchedule.scheduleDate);

      this.logger.log(`获取到 ${schedules.length} 条节日&重保排班记录`);

      return {
        schedules: schedules.map((s) => ({
          id: s.id,
          recordId: s.recordId,
          dutyCode: s.dutyCode,
          code: s.code,
          scheduleDate: s.scheduleDate,
          dutyType: s.dutyType,
          scheduleWeekday: s.scheduleWeekday,
          weekNumber: s.weekNumber,
          building: s.building,
          dutyStaff: s.dutyStaff,
          dutyStaffText: s.dutyStaffText,
        })),
      };
    } catch (error) {
      this.logger.error('获取节日&重保排班列表失败', error);
      throw error;
    }
  }

  /**
   * 获取节日重要排班列表（从 app_festival_important_schedule 表）
   */
  async getFestivalSchedules(
    params: { startDate?: string; endDate?: string } = {},
  ) {
    try {
      this.logger.log('获取节日重要排班列表');

      if (isDatabaseDisabled()) {
        return this.getFestivalSchedulesFromFeishu(params);
      }

      const conditions = [];
      if (params.startDate) {
        conditions.push(
          sql`${appFestivalImportantSchedule.appScheduleDate} >= ${params.startDate}`,
        );
      }
      if (params.endDate) {
        conditions.push(
          sql`${appFestivalImportantSchedule.appScheduleDate} <= ${params.endDate}`,
        );
      }

      const query =
        conditions.length > 0
          ? this.db
              .select()
              .from(appFestivalImportantSchedule)
              .where(and(...conditions))
          : this.db.select().from(appFestivalImportantSchedule);

      const schedules = await query.orderBy(
        appFestivalImportantSchedule.appScheduleDate,
      );

      if (schedules.length === 0 && (params.startDate || params.endDate)) {
        try {
          const feishuSchedules =
            await this.getFestivalSchedulesFromFeishu(params);
          if (feishuSchedules.schedules.length > 0) {
            return feishuSchedules;
          }
        } catch (feishuError) {
          const message =
            feishuError instanceof Error
              ? feishuError.message
              : String(feishuError);
          this.logger.warn(
            `飞书直读节日重保排班失败，继续使用本地结果: ${message}`,
          );
        }
      }

      this.logger.log(`获取到 ${schedules.length} 条节日重要排班记录`);

      return {
        schedules: schedules.map((s) => ({
          id: s.id,
          recordId: s.recordId,
          appShiftId: s.appShiftId,
          appCode: s.appCode,
          appScheduleDate: s.appScheduleDate,
          appHeavyType: s.appHeavyType,
          appScheduleDateWeek: s.appScheduleDateWeek,
          appYearWeek: s.appYearWeek,
          appDutyBuilding: s.appDutyBuilding,
          appDutyStaff: s.appDutyStaff,
          appStaffText: s.appStaffText,
        })),
      };
    } catch (error) {
      this.logger.error('获取节日重要排班列表失败', error);
      throw error;
    }
  }

  /**
   * 获取非值班排班列表
   */
  async getNonDutySchedules(
    params: {
      startDate?: string;
      endDate?: string;
      building?: string;
      team?: string;
    } = {},
  ) {
    try {
      this.logger.log('获取非值班排班列表');
      return this.getNonDutySchedulesFromFeishu(params);
    } catch (error) {
      this.logger.error('获取非值班排班列表失败', error);
      throw error;
    }
  }

  /**
   * 获取值班人员列表（从员工资质信息表中筛选值班长/值班员）
   */
  async getDutyStaff() {
    try {
      this.logger.log('获取值班人员列表');

      if (isDatabaseDisabled()) {
        const records = await this.fetchFeishuOrganizationRecords();
        const staff = this.mapFeishuEmployeeRecordsToDutyStaff(records);
        this.logger.log(`飞书直读在职人员值班人员: ${staff.length} 条`);
        return {
          staff: this.buildDutyStaffByBuilding(staff),
        };
      }

      const staff = await this.db
        .select({
          id: appEmployeeCertInfoFormal.id,
          appName: appEmployeeCertInfoFormal.appName,
          position: appEmployeeCertInfoFormal.position,
          buildingProfessional: appEmployeeCertInfoFormal.buildingProfessional,
          shift: appEmployeeCertInfoFormal.shift,
        })
        .from(appEmployeeCertInfoFormal)
        .where(
          sql`${appEmployeeCertInfoFormal.position} IN ('运维值班长', '运维值班员', '运维实习生', '110值班人员', '110站站长', 'H楼值班主管')`,
        );

      this.logger.log(`获取到 ${staff.length} 条值班人员记录`);

      if (staff.length === 0 && this.ORG_APP_TOKEN && this.ORG_TABLE_ID) {
        const records = await this.fetchFeishuOrganizationRecords();
        const directStaff = this.mapFeishuEmployeeRecordsToDutyStaff(records);
        this.logger.log(
          `员工证书表为空，飞书在职人员兜底返回 ${directStaff.length} 条值班人员`,
        );
        return {
          staff: this.buildDutyStaffByBuilding(directStaff),
        };
      }

      // 按楼栋分组
      const buildingMap = new Map<
        string,
        Map<
          string,
          { leader: (typeof staff)[0] | null; staff: (typeof staff)[0] | null }
        >
      >();

      // 楼栋名称映射
      const buildingNameMap: Record<string, string> = {
        H楼: 'H楼',
        A楼: 'A楼',
        B楼: 'B楼',
        C楼: 'C楼',
        D楼: 'D楼',
        E楼: 'E楼',
        '110站': '110站',
      };

      // 班次名称映射
      const shiftNameMap: Record<string, string> = {
        A班: 'A班',
        B班: 'B班',
        C班: 'C班',
        D班: 'D班',
      };

      // 110站人员单独收集
      const station110Staff: typeof staff = [];
      let station110Chief: (typeof staff)[0] | null = null; // 110站站长

      staff.forEach((person) => {
        const buildings = person.buildingProfessional || [];
        const shift = person.shift || '';
        const position = person.position || '';

        buildings.forEach((building: string) => {
          // 标准化楼栋名称
          let normalizedBuilding = building;
          if (!buildingNameMap[building]) {
            // 尝试匹配
            const match = Object.keys(buildingNameMap).find((key) =>
              building.includes(key),
            );
            if (match) normalizedBuilding = match;
            else return; // 跳过不匹配的楼栋
          }

          // 110站特殊处理 - 收集所有人员
          if (normalizedBuilding === '110站') {
            if (position === '110站站长') {
              station110Chief = person;
            } else {
              station110Staff.push(person);
            }
            return;
          }

          // 标准化班次名称
          let normalizedShift = shift;
          if (!shiftNameMap[shift]) {
            const match = Object.keys(shiftNameMap).find((key) =>
              shift.includes(key),
            );
            if (match) normalizedShift = match;
            else normalizedShift = 'A班'; // 默认A班
          }

          if (!buildingMap.has(normalizedBuilding)) {
            buildingMap.set(normalizedBuilding, new Map());
          }

          const shiftMap = buildingMap.get(normalizedBuilding)!;
          if (!shiftMap.has(normalizedShift)) {
            shiftMap.set(normalizedShift, { leader: null, staff: null });
          }

          const shiftData = shiftMap.get(normalizedShift)!;
          if (position === '运维值班长' || position === 'H楼值班主管') {
            shiftData.leader = person;
          } else if (position === '运维值班员' || position === '运维实习生') {
            shiftData.staff = person;
          }
        });
      });

      // 转换为响应格式
      const result = Array.from(buildingMap.entries()).map(
        ([building, shiftMap]) => {
          const shifts = Array.from(shiftMap.entries()).map(
            ([shift, data]) => ({
              shift,
              leader: data.leader
                ? {
                    id: data.leader.id,
                    profileSource: 'certificate',
                    appName: data.leader.appName,
                    position: data.leader.position,
                    buildingProfessional:
                      data.leader.buildingProfessional || [],
                    shift: data.leader.shift,
                  }
                : null,
              staff: data.staff
                ? {
                    id: data.staff.id,
                    profileSource: 'certificate',
                    appName: data.staff.appName,
                    position: data.staff.position,
                    buildingProfessional: data.staff.buildingProfessional || [],
                    shift: data.staff.shift,
                  }
                : null,
            }),
          );

          // 按班次排序
          const shiftOrder = ['A班', 'B班', 'C班', 'D班'];
          shifts.sort(
            (a, b) => shiftOrder.indexOf(a.shift) - shiftOrder.indexOf(b.shift),
          );

          return {
            building,
            shifts,
          };
        },
      );

      // 添加110站数据（特殊格式：站长 + 值班员列表）
      if (station110Staff.length > 0 || station110Chief) {
        const staffList = station110Staff.slice(0, 7).map((person) => ({
          id: person.id,
          profileSource: 'certificate' as const,
          appName: person.appName,
          position: person.position,
          buildingProfessional: person.buildingProfessional || [],
          shift: person.shift,
        }));
        // 补足7个
        while (staffList.length < 7) {
          staffList.push(null as any);
        }

        result.push({
          building: '110站',
          shifts: [
            {
              shift: '站长',
              leader: null,
              staff: station110Chief
                ? {
                    id: station110Chief.id,
                    profileSource: 'certificate',
                    appName: station110Chief.appName,
                    position: station110Chief.position,
                    buildingProfessional:
                      station110Chief.buildingProfessional || [],
                    shift: station110Chief.shift,
                  }
                : null,
            },
            ...staffList.map((s, i) => ({
              shift: `值班员${i + 1}`,
              leader: null,
              staff: s,
            })),
          ],
        });
      }

      // 按楼栋排序
      const buildingOrder = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'];
      result.sort(
        (a, b) =>
          buildingOrder.indexOf(a.building) - buildingOrder.indexOf(b.building),
      );

      return {
        staff: result,
      };
    } catch (error) {
      this.logger.error('获取值班人员列表失败', error);
      throw error;
    }
  }

  /**
   * 调试：从飞书获取单条记录详情
   */
  async debugRecordFromFeishu(recordId: string) {
    try {
      assertBitableTableConfig(
        '非值班排班',
        this.NON_DUTY_APP_TOKEN,
        this.NON_DUTY_TABLE_ID,
      );
      const tenantAccessToken = await this.getTenantAccessToken();

      // 查询单条记录 - 不使用 field_names 参数获取所有字段
      const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.NON_DUTY_APP_TOKEN}/tables/${this.NON_DUTY_TABLE_ID}/records/${recordId}`;

      const response = await this.httpService.axiosRef.get(apiUrl, {
        headers: { Authorization: 'Bearer ' + tenantAccessToken },
        timeout: 30000,
      });

      if (response.data.code !== 0) {
        throw new Error(`飞书 API 错误: ${response.data.msg}`);
      }

      const record = response.data.data.record;
      const fields = record.fields;

      // 查找所有包含"请假"的字段
      const allFieldNames = Object.keys(fields || {});
      const leaveRelatedFields = allFieldNames.filter((k) =>
        k.includes('请假'),
      );

      // 获取字段值的详细信息 - 同时检查字段名和字段ID
      const leaveStaffBitableFieldByName = fields?.['请假人员（请假表）'];
      const leaveStaffBitableFieldById = fields?.['fld4xMPICY'];
      const leaveStaffField = fields?.['请假人员'];

      // 优先使用字段ID获取的值
      const leaveStaffBitableField =
        leaveStaffBitableFieldById || leaveStaffBitableFieldByName;

      return {
        recordId: record.id,
        allFieldNames: allFieldNames,
        leaveRelatedFields: leaveRelatedFields,
        // 请假人员（请假表）字段 - 通过字段ID
        leaveStaffBitableFieldId: 'fld4xMPICY',
        leaveStaffBitableByIdExists: 'fld4xMPICY' in (fields || {}),
        leaveStaffBitableByIdRaw: leaveStaffBitableFieldById,
        // 请假人员（请假表）字段 - 通过字段名
        leaveStaffBitableFieldName: '请假人员（请假表）',
        leaveStaffBitableByNameExists: '请假人员（请假表）' in (fields || {}),
        leaveStaffBitableByNameRaw: leaveStaffBitableFieldByName,
        // 合并后的结果
        leaveStaffBitableCombined: leaveStaffBitableField,
        leaveStaffBitableType: leaveStaffBitableField
          ? typeof leaveStaffBitableField
          : 'undefined',
        leaveStaffBitableIsArray: Array.isArray(leaveStaffBitableField),
        leaveStaffBitableExtracted: this.extractUserIds(leaveStaffBitableField),
        // 请假人员字段
        leaveStaffFieldName: '请假人员',
        leaveStaffExists: '请假人员' in (fields || {}),
        leaveStaffRaw: leaveStaffField,
        leaveStaffType: leaveStaffField ? typeof leaveStaffField : 'undefined',
        leaveStaffText: this.extractTextValue(leaveStaffField),
        // 其他字段
        dutyStaffActual: fields?.['值班人员（实际）'],
        dutyStaffActualText: this.extractTextValue(
          fields?.['值班人员（实际）'],
        ),
        // 完整原始数据（用于调试）
        rawFields: fields,
      };
    } catch (error) {
      this.logger.error(`获取飞书记录 ${recordId} 详情失败`, error);
      throw error;
    }
  }

  /**
   * 获取非值班排班表字段列表
   */
  async getNonDutyTableFields() {
    try {
      this.logger.log('获取非值班排班表字段列表');

      assertBitableTableConfig(
        '非值班排班',
        this.NON_DUTY_APP_TOKEN,
        this.NON_DUTY_TABLE_ID,
      );
      const tenantAccessToken = await this.getTenantAccessToken();

      // 查询表格字段列表
      const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.NON_DUTY_APP_TOKEN}/tables/${this.NON_DUTY_TABLE_ID}/fields`;

      const response = await this.httpService.axiosRef.get(apiUrl, {
        headers: { Authorization: 'Bearer ' + tenantAccessToken },
        timeout: 30000,
      });

      if (response.data.code !== 0) {
        throw new Error(`飞书 API 错误: ${response.data.msg}`);
      }

      const fields = response.data.data.items || [];

      // 筛选出与请假相关的字段
      const leaveRelatedFields = fields.filter(
        (f: { field_name?: string; field_id?: string }) =>
          f.field_name?.includes('请假') || f.field_id?.includes('leave'),
      );

      return {
        totalFields: fields.length,
        allFields: fields.map(
          (f: { field_id: string; field_name: string; type: string }) => ({
            field_id: f.field_id,
            field_name: f.field_name,
            type: f.type,
          }),
        ),
        leaveRelatedFields: leaveRelatedFields.map(
          (f: {
            field_id: string;
            field_name: string;
            type: string;
            property?: unknown;
          }) => ({
            field_id: f.field_id,
            field_name: f.field_name,
            type: f.type,
            property: f.property,
          }),
        ),
      };
    } catch (error) {
      this.logger.error('获取表格字段列表失败', error);
      throw error;
    }
  }

  /**
   * 验证请假数据一致性
   * 检查数据库中 leave_staff_bitable 有值但 API 可能返回不一致的记录
   */
  async verifyLeaveDataConsistency() {
    this.logger.log('开始验证请假数据一致性...');

    try {
      // 1. 获取数据库中所有 leave_staff_bitable 不为空的记录
      const dbRecords = await this.db
        .select({
          id: nonDutySchedule.id,
          recordId: nonDutySchedule.recordId,
          scheduleDate: nonDutySchedule.scheduleDate,
          building: nonDutySchedule.building,
          team: nonDutySchedule.team,
          leaveStaffBitable: nonDutySchedule.leaveStaffBitable,
          dutyCode: nonDutySchedule.dutyCode,
        })
        .from(nonDutySchedule)
        .where(sql`array_length(${nonDutySchedule.leaveStaffBitable}, 1) > 0`);

      this.logger.log(
        `数据库中共有 ${dbRecords.length} 条 leave_staff_bitable 不为空的记录`,
      );

      assertBitableTableConfig(
        '非值班排班',
        this.NON_DUTY_APP_TOKEN,
        this.NON_DUTY_TABLE_ID,
      );
      const tenantAccessToken = await this.getTenantAccessToken();

      // 3. 批量检查 API 返回的数据
      const inconsistentRecords: unknown[] = [];
      const checkedCount = Math.min(dbRecords.length, 50); // 最多检查50条

      for (let i = 0; i < checkedCount; i++) {
        const record = dbRecords[i];
        try {
          const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.NON_DUTY_APP_TOKEN}/tables/${this.NON_DUTY_TABLE_ID}/records/${record.recordId}`;

          const response = await this.httpService.axiosRef.get(apiUrl, {
            headers: { Authorization: 'Bearer ' + tenantAccessToken },
            timeout: 10000,
          });

          if (response.data.code !== 0) {
            this.logger.warn(
              `获取记录 ${record.recordId} 失败: ${response.data.msg}`,
            );
            continue;
          }

          const fields = response.data.data.record.fields;
          const apiLeaveStaffBitable = fields?.['请假人员（请假表）'];
          const apiExtracted = this.extractUserIds(apiLeaveStaffBitable);

          // 转换数据库值为数组 - leaveStaffBitable 是 string[] 类型
          const dbValue = record.leaveStaffBitable;
          const dbArray = Array.isArray(dbValue) ? dbValue : [];

          // 检查是否一致
          const isConsistent =
            apiExtracted.length === dbArray.length &&
            apiExtracted.every((v: string) => dbArray.includes(v)) &&
            dbArray.every((v: string) => apiExtracted.includes(v));

          if (!isConsistent) {
            inconsistentRecords.push({
              recordId: record.recordId,
              scheduleDate: record.scheduleDate,
              building: record.building,
              team: record.team,
              dutyCode: record.dutyCode,
              dbValue: dbArray,
              apiValue: apiExtracted,
              apiRaw: apiLeaveStaffBitable,
            });
          }
        } catch (error) {
          this.logger.error(`检查记录 ${record.recordId} 时出错`, error);
        }
      }

      // 4. 检查数据库中 leave_staff_bitable 为空但应该有值的记录
      const emptyDbRecords = await this.db
        .select({
          id: nonDutySchedule.id,
          recordId: nonDutySchedule.recordId,
          scheduleDate: nonDutySchedule.scheduleDate,
          building: nonDutySchedule.building,
          team: nonDutySchedule.team,
          leaveStaffBitable: nonDutySchedule.leaveStaffBitable,
          personText: nonDutySchedule.personText,
          dutyStaffActual: nonDutySchedule.dutyStaffActual,
        })
        .from(nonDutySchedule)
        .where(
          sql`(${nonDutySchedule.leaveStaffBitable} IS NULL OR array_length(${nonDutySchedule.leaveStaffBitable}, 1) IS NULL OR array_length(${nonDutySchedule.leaveStaffBitable}, 1) = 0)`,
        )
        .limit(100);

      const potentiallyMissingRecords: unknown[] = [];
      const checkEmptyCount = Math.min(emptyDbRecords.length, 30); // 检查30条空记录

      for (let i = 0; i < checkEmptyCount; i++) {
        const record = emptyDbRecords[i];
        try {
          const apiUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.NON_DUTY_APP_TOKEN}/tables/${this.NON_DUTY_TABLE_ID}/records/${record.recordId}`;

          const response = await this.httpService.axiosRef.get(apiUrl, {
            headers: { Authorization: 'Bearer ' + tenantAccessToken },
            timeout: 10000,
          });

          if (response.data.code !== 0) continue;

          const fields = response.data.data.record.fields;
          const apiLeaveStaffBitable = fields?.['请假人员（请假表）'];
          const apiExtracted = this.extractUserIds(apiLeaveStaffBitable);

          if (apiExtracted.length > 0) {
            potentiallyMissingRecords.push({
              recordId: record.recordId,
              scheduleDate: record.scheduleDate,
              building: record.building,
              team: record.team,
              personText: record.personText,
              dutyStaffActual: record.dutyStaffActual,
              apiLeaveStaff: apiExtracted,
            });
          }
        } catch (error) {
          // 忽略单个记录的错误
        }
      }

      return {
        summary: {
          totalDbRecordsWithLeave: dbRecords.length,
          checkedCount: checkedCount,
          inconsistentCount: inconsistentRecords.length,
          emptyRecordsChecked: checkEmptyCount,
          potentiallyMissingCount: potentiallyMissingRecords.length,
        },
        inconsistentRecords: inconsistentRecords,
        potentiallyMissingRecords: potentiallyMissingRecords,
      };
    } catch (error) {
      this.logger.error('验证请假数据一致性失败', error);
      throw error;
    }
  }

  /**
   * 获取今日请假人员列表（从 non_duty_schedule 和 app_room_schedule_enhanced 两个表）
   */
  private requiresApprovalAwareLeaveSourceRead(): boolean {
    // 两张本地表都没有“审批已验证”标记，旧缓存必须按失败关闭处理。
    return true;
  }

  async getTodayLeaveStaff(date: string, forceRefresh = false) {
    try {
      this.logger.log(`获取今日请假人员列表，日期: ${date}`);

      if (
        this.requiresApprovalAwareLeaveSourceRead() ||
        isDatabaseDisabled() ||
        forceRefresh
      ) {
        return this.getTodayLeaveStaffFromFeishu(date, forceRefresh);
      }

      // 楼栋名称映射（支持多种格式）
      const buildingNameMap: Record<string, string> = {
        A: 'A栋',
        B: 'B栋',
        C: 'C栋',
        D: 'D栋',
        E: 'E栋',
        H: 'H栋',
        '110': '110站',
        A楼: 'A栋',
        B楼: 'B栋',
        C楼: 'C栋',
        D楼: 'D栋',
        E楼: 'E栋',
        H楼: 'H栋',
        '110站': '110站',
      };

      // 从 non_duty_schedule 表获取请假数据 (leave_staff_bitable 字段)
      const nonDutyRecords = await this.db
        .select({
          building: nonDutySchedule.building,
          leaveStaffBitable: nonDutySchedule.leaveStaffBitable,
          substituteStaffBitable: nonDutySchedule.substituteStaffBitable,
        })
        .from(nonDutySchedule)
        .where(eq(nonDutySchedule.scheduleDate, date));

      // 从 app_room_schedule_enhanced 表获取请假数据 (leave_staff 字段)
      const roomRecords = await this.db
        .select({
          building: appRoomScheduleEnhanced.building,
          dutyStaffReference: appRoomScheduleEnhanced.dutyStaffReference,
          dutyStaffActual: appRoomScheduleEnhanced.dutyStaffActual,
          actualDutyStaff: appRoomScheduleEnhanced.actualDutyStaff,
          leaveStaff: appRoomScheduleEnhanced.leaveStaff,
          personText: appRoomScheduleEnhanced.personText,
          substituteStaff: appRoomScheduleEnhanced.substituteStaff,
          shift: appRoomScheduleEnhanced.shift,
          shiftText: appRoomScheduleEnhanced.shiftText,
        })
        .from(appRoomScheduleEnhanced)
        .where(eq(appRoomScheduleEnhanced.scheduleDate, date));

      // 合并两个表的数据，按楼栋分组
      const buildingData = new Map<string, TodayLeaveBuildingData>();

      // 处理 non_duty_schedule 表的数据
      for (const record of nonDutyRecords) {
        if (!record.building) continue;

        const buildingKey = record.building
          .replace(/^(app_|building_)/, '')
          .replace('_building', '')
          .replace('station_', '');
        const buildingName =
          buildingNameMap[buildingKey.toUpperCase()] || buildingKey;

        const data = this.getOrCreateTodayLeaveBuildingData(
          buildingData,
          buildingName,
        );

        if (
          record.leaveStaffBitable &&
          Array.isArray(record.leaveStaffBitable)
        ) {
          for (const staff of record.leaveStaffBitable) {
            if (staff) {
              for (const name of this.splitStaffNames(staff)) {
                data.leaveStaff.add(name);
              }
            }
          }
        }

        if (
          record.substituteStaffBitable &&
          Array.isArray(record.substituteStaffBitable)
        ) {
          for (const staff of record.substituteStaffBitable) {
            if (staff) {
              for (const name of this.splitStaffNames(staff)) {
                data.substituteStaff.add(name);
              }
            }
          }
        }
      }

      // 处理 app_room_schedule_enhanced 表的数据
      for (const record of roomRecords) {
        if (!record.building) continue;

        // 解析楼栋名称 (格式如: app_a_building, station_110 等)
        const buildingKey = record.building
          .replace(/^(app_|building_)/, '')
          .replace('_building', '')
          .replace('station_', '');
        const buildingName =
          buildingNameMap[buildingKey.toUpperCase()] || buildingKey;

        const data = this.getOrCreateTodayLeaveBuildingData(
          buildingData,
          buildingName,
        );

        const leaveStaff = Array.isArray(record.leaveStaff)
          ? record.leaveStaff.flatMap((staff) => this.splitStaffNames(staff))
          : [];
        for (const name of leaveStaff) {
          data.leaveStaff.add(name);
        }

        const substituteStaff = Array.isArray(record.substituteStaff)
          ? record.substituteStaff.flatMap((staff) =>
              this.splitStaffNames(staff),
            )
          : [];
        const plannedStaff =
          Array.isArray(record.dutyStaffReference) &&
          record.dutyStaffReference.length > 0
            ? record.dutyStaffReference.flatMap((staff) =>
                this.splitStaffNames(staff),
              )
            : this.splitStaffNames(record.personText);
        const actualStaff =
          Array.isArray(record.dutyStaffActual) &&
          record.dutyStaffActual.length > 0
            ? record.dutyStaffActual.flatMap((staff) =>
                this.splitStaffNames(staff),
              )
            : this.splitStaffNames(record.actualDutyStaff);
        const inferredLeaveSubstituteStaff =
          leaveStaff.length > 0 && substituteStaff.length === 0
            ? inferActualSubstituteStaff({
                plannedStaff,
                leaveStaff,
                actualStaff,
              })
            : [];
        const inferredTemporarySubstituteStaff =
          substituteStaff.length === 0
            ? inferTemporarySubstituteStaff({
                plannedStaff,
                leaveStaff,
                actualStaff,
              })
            : [];
        const leaveSubstituteStaff =
          leaveStaff.length > 0
            ? [...substituteStaff, ...inferredLeaveSubstituteStaff]
            : [];
        const temporarySubstituteStaff =
          leaveStaff.length === 0
            ? [...substituteStaff, ...inferredTemporarySubstituteStaff]
            : [];
        for (const name of leaveSubstituteStaff) {
          data.substituteStaff.add(name);
        }
        this.addTodayTemporarySubstituteStaff(
          data,
          record.shiftText || record.shift,
          temporarySubstituteStaff,
        );
      }

      // 转换为响应格式
      const buildings = Array.from(buildingData.entries())
        .map(([buildingName, data]) => ({
          building: this.getTodayLeaveBuildingCode(buildingName),
          buildingName,
          leaveStaff: Array.from(data.leaveStaff),
          substituteStaff: Array.from(data.substituteStaff),
          temporarySubstituteStaff: Array.from(data.temporarySubstituteStaff),
          temporarySubstitutes: Array.from(
            data.temporarySubstitutesByShift.values(),
          ).map((group) => ({
            shift: group.shift,
            shiftLabel: group.shiftLabel,
            staff: Array.from(group.staff),
          })),
        }))
        .filter(
          (b) =>
            b.leaveStaff.length > 0 ||
            b.substituteStaff.length > 0 ||
            b.temporarySubstituteStaff.length > 0,
        )
        .sort((a, b) => {
          const order = ['A栋', 'B栋', 'C栋', 'D栋', 'E栋', 'H栋', '110站'];
          return order.indexOf(a.buildingName) - order.indexOf(b.buildingName);
        });

      const totalLeaveCount = buildings.reduce(
        (sum, b) => sum + b.leaveStaff.length,
        0,
      );

      this.logger.log(
        `获取到 ${buildings.length} 个楼栋的请假数据，共 ${totalLeaveCount} 人请假`,
      );

      return {
        date,
        buildings,
        totalLeaveCount,
      };
    } catch (error) {
      this.logger.error('获取今日请假人员列表失败', error);
      throw error;
    }
  }

  /**
   * 和风天气API配置
   */
  private readonly QWEATHER_KEY = readEnv('QWEATHER_KEY');
  private readonly QWEATHER_BASE_URL =
    readEnv('QWEATHER_BASE_URL') || 'https://devapi.qweather.com/v7';
  // 南通开发区地理位置坐标（近似）
  private readonly NANTONG_LOCATION =
    readEnv('QWEATHER_LOCATION') || '120.86,32.03';
  private readonly CHINA_WEATHER_BASE_URL =
    readEnv('CHINA_WEATHER_BASE_URL') ||
    'http://t.weather.itboy.net/api/weather/city';
  private readonly CHINA_WEATHER_CITY_ID =
    readEnv('CHINA_WEATHER_CITY_ID') || '101190501';
  private readonly QWEATHER_WARNING_LOCATION =
    readEnv('QWEATHER_WARNING_LOCATION') ||
    this.CHINA_WEATHER_CITY_ID ||
    '101190501';
  private readonly WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;
  private readonly WEATHER_WARNING_CACHE_TTL_MS = 10 * 60 * 1000;
  private readonly WEATHER_WARNING_STALE_AFTER_MS = 20 * 60 * 1000;
  private weatherNowCache?: { expiresAt: number; data: unknown };
  private weatherHourlyCache?: { expiresAt: number; data: unknown };
  private weatherWarningCache?: {
    expiresAt: number;
    data: QWeatherWarningResponse;
    fetchedAt: string;
  };
  private weatherWarningLastSuccess?: {
    data: QWeatherWarningResponse;
    fetchedAt: string;
  };
  private weatherWarningFetchInFlight?: Promise<
    WeatherWarningFetchResult<QWeatherWarningResponse>
  >;

  /**
   * 获取实时天气数据
   */
  async getWeatherNow() {
    if (this.weatherNowCache && this.weatherNowCache.expiresAt > Date.now()) {
      return this.weatherNowCache.data;
    }

    try {
      if (!this.QWEATHER_KEY) {
        const data = await this.getFallbackWeatherNow();
        this.weatherNowCache = {
          data,
          expiresAt: Date.now() + this.WEATHER_CACHE_TTL_MS,
        };
        return data;
      }
      this.logger.log('开始获取实时天气数据');
      const response = await this.httpService.axiosRef.get(
        `${this.QWEATHER_BASE_URL}/weather/now?location=${this.NANTONG_LOCATION}&key=${this.QWEATHER_KEY}`,
        { timeout: 3000 },
      );

      if (response.data.code !== '200') {
        throw new Error(`天气API错误: ${response.data.code}`);
      }

      this.logger.log('获取实时天气数据成功');
      this.weatherNowCache = {
        data: response.data,
        expiresAt: Date.now() + this.WEATHER_CACHE_TTL_MS,
      };
      return response.data;
    } catch (error) {
      this.logger.warn(
        `获取实时天气数据失败，尝试使用兜底天气源: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        const data = await this.getFallbackWeatherNow();
        this.weatherNowCache = {
          data,
          expiresAt: Date.now() + this.WEATHER_CACHE_TTL_MS,
        };
        return data;
      } catch (fallbackError) {
        this.logger.warn(
          `兜底天气源也不可用: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
      // 返回默认数据，避免前端显示错误
      return {
        code: '200',
        now: {
          temp: '--',
          feelsLike: '--',
          icon: '999',
          text: '待更新',
          windDir: '--',
          windScale: '--',
          humidity: '--',
        },
      };
    }
  }

  /**
   * 获取天气预警信息
   */
  async getWeatherWarning(
    forceRefresh = false,
  ): Promise<QWeatherWarningResponse> {
    const result = await this.getWeatherWarningFetchResult(forceRefresh);
    return result.state === 'fresh' && result.data
      ? result.data
      : this.normalizeQWeatherWarningResponse({ code: '200', warning: [] });
  }

  getWeatherWarningFetchResult(
    forceRefresh = false,
  ): Promise<WeatherWarningFetchResult<QWeatherWarningResponse>> {
    const nowMs = Date.now();
    if (
      !forceRefresh &&
      this.weatherWarningCache &&
      this.weatherWarningCache.expiresAt > nowMs
    ) {
      return Promise.resolve(
        resolveWeatherWarningSourceStatus({
          nowMs,
          staleAfterMs: this.WEATHER_WARNING_STALE_AFTER_MS,
          latest: this.weatherWarningCache.data,
          latestFetchedAt: this.weatherWarningCache.fetchedAt,
          lastSuccess: this.weatherWarningLastSuccess?.data,
          lastSuccessAt: this.weatherWarningLastSuccess?.fetchedAt,
        }),
      );
    }

    if (this.weatherWarningFetchInFlight) {
      return this.weatherWarningFetchInFlight;
    }

    const fetchPromise = (async () => {
      try {
        const data = await this.fetchWeatherWarningSnapshot();
        const fetchedAt = new Date().toISOString();
        this.weatherWarningCache = {
          data,
          fetchedAt,
          expiresAt: Date.now() + this.WEATHER_WARNING_CACHE_TTL_MS,
        };
        this.weatherWarningLastSuccess = { data, fetchedAt };
        return resolveWeatherWarningSourceStatus({
          nowMs: Date.now(),
          staleAfterMs: this.WEATHER_WARNING_STALE_AFTER_MS,
          latest: data,
          latestFetchedAt: fetchedAt,
          lastSuccess: data,
          lastSuccessAt: fetchedAt,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(`获取天气预警信息失败: ${errorMessage}`);
        return resolveWeatherWarningSourceStatus({
          nowMs: Date.now(),
          staleAfterMs: this.WEATHER_WARNING_STALE_AFTER_MS,
          lastSuccess: this.weatherWarningLastSuccess?.data,
          lastSuccessAt: this.weatherWarningLastSuccess?.fetchedAt,
          errorMessage,
        });
      }
    })();

    this.weatherWarningFetchInFlight = fetchPromise;
    void fetchPromise.finally(() => {
      if (this.weatherWarningFetchInFlight === fetchPromise) {
        this.weatherWarningFetchInFlight = undefined;
      }
    });
    return fetchPromise;
  }

  private async fetchWeatherWarningSnapshot(): Promise<QWeatherWarningResponse> {
    const sourceErrors: string[] = [];

    if (this.QWEATHER_KEY) {
      this.logger.log('开始获取天气预警信息');
      const warningLocations = Array.from(
        new Set(
          [
            this.NANTONG_LOCATION,
            this.QWEATHER_WARNING_LOCATION,
            this.CHINA_WEATHER_CITY_ID,
          ].filter(Boolean),
        ),
      );

      for (const location of warningLocations) {
        try {
          const data = await this.fetchQWeatherWarning(location);
          this.logger.log(`获取天气预警信息成功: ${location}`);
          return data;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sourceErrors.push(`和风天气(${location})：${message}`);
        }
      }
    } else {
      sourceErrors.push('未配置和风天气密钥');
    }

    try {
      return await this.getFallbackWeatherWarning();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sourceErrors.push(`兜底天气预警源：${message}`);
    }

    throw new Error(sourceErrors.join('；') || '天气预警源不可用');
  }

  private async fetchQWeatherWarning(
    location: string,
  ): Promise<QWeatherWarningResponse> {
    const response =
      await this.httpService.axiosRef.get<QWeatherWarningResponse>(
        `${this.QWEATHER_BASE_URL}/warning/now?location=${encodeURIComponent(location)}&lang=zh&key=${this.QWEATHER_KEY}`,
        { timeout: 5000 },
      );

    if (response.data.code !== '200') {
      throw new Error(`天气预警API错误: ${response.data.code}`);
    }

    return response.data;
  }

  private async getFallbackWeatherWarning(): Promise<QWeatherWarningResponse> {
    const cityId =
      this.QWEATHER_WARNING_LOCATION ||
      this.CHINA_WEATHER_CITY_ID ||
      '101190501';
    const url = `https://www.qweather.com/severe-weather/nantong-${encodeURIComponent(cityId)}.html`;
    const response = await this.httpService.axiosRef.get<string>(url, {
      responseType: 'text',
      timeout: 8000,
      transformResponse: [(data) => data],
    });
    const html = String(response.data || '');
    if (this.isFallbackWeatherWarningErrorPage(html)) {
      throw new Error('QWeather预警页面包含错误页标识');
    }

    const warning = this.parseQWeatherPublicWarnings(html, cityId);
    if (!this.isRecognizedQWeatherWarningPage(html, warning)) {
      throw new Error('QWeather预警页面结构无法识别');
    }

    return {
      code: '200',
      updateTime: new Date().toISOString(),
      fxLink: url,
      warning,
      refer: {
        sources: ['QWeather', '国家预警信息发布中心 (12379)'],
      },
    };
  }

  private isFallbackWeatherWarningErrorPage(html: string): boolean {
    const contentHtml = this.stripNonContentHtml(html);
    return /(?:登录|login|gateway|无权限|访问受限|权限\s*不足|access\s*denied|forbidden|unauthorized|\berror\b|错误)/i.test(
      this.cleanHtmlText(contentHtml),
    );
  }

  private isRecognizedQWeatherWarningPage(
    html: string,
    warning: QWeatherWarningItem[],
  ): boolean {
    if (warning.length > 0) {
      return true;
    }

    const contentHtml = this.stripNonContentHtml(html);
    const hasOfficialWarningPage =
      /<[^>]+\bclass\s*=\s*["'][^"']*\bl-page-city-warning\b[^"']*["'][^>]*>/i.test(
        contentHtml,
      );
    const hasOfficialNoDataState =
      /<[^>]+\bclass\s*=\s*["'][^"']*\bc-city-warning-no-data\b[^"']*["'][^>]*>/i.test(
        contentHtml,
      );
    if (!hasOfficialWarningPage || !hasOfficialNoDataState) {
      return false;
    }

    const text = this.cleanHtmlText(contentHtml);
    return ['暂无预警', '暂无气象预警', '当前暂无气象预警'].some((phrase) =>
      text.includes(phrase),
    );
  }

  private stripNonContentHtml(html: string): string {
    return html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  }

  private normalizeQWeatherWarningResponse(
    data: QWeatherWarningResponse,
  ): QWeatherWarningResponse {
    return {
      ...data,
      warning: (data.warning || []).map((item) => ({
        ...item,
        level:
          item.level ||
          this.mapWeatherWarningColor(item.severityColor) ||
          item.severity ||
          '',
        type:
          item.type ||
          item.typeName ||
          this.extractWeatherWarningType(item.title || ''),
        text: item.text || '',
      })),
    };
  }

  private parseQWeatherPublicWarnings(
    html: string,
    cityId: string,
  ): QWeatherWarningItem[] {
    const warnings: QWeatherWarningItem[] = [];
    const eventRegex =
      /<div class="c-city-warning-events\s+warning--([^"]+)">/g;
    let match: RegExpExecArray | null;

    while ((match = eventRegex.exec(html)) !== null) {
      const startIndex = match.index;
      const nextIndex = html.indexOf(
        '<div class="qweather-list__row">',
        startIndex + 1,
      );
      const block = html.slice(
        startIndex,
        nextIndex > startIndex ? nextIndex : undefined,
      );
      const title = this.cleanHtmlText(
        this.extractFirstMatch(block, /<h3>([\s\S]*?)<\/h3>/),
      );
      const pubTime = this.cleanHtmlText(
        this.extractFirstMatch(block, /发布日期：\s*([^<]+)/),
      );
      const text = this.cleanHtmlText(
        this.extractFirstMatch(
          block,
          /<p class="warning-events__txt">([\s\S]*?)<\/p>/,
        ),
      );
      const level =
        this.mapWeatherWarningColor(match[1]) ||
        this.extractWeatherWarningLevel(title) ||
        '';
      const type = this.extractWeatherWarningType(title);

      if (!title && !text) {
        continue;
      }

      warnings.push({
        id: `qweather-public-${cityId}-${pubTime || warnings.length}-${title}`,
        sender: title.replace(/发布.+$/, '') || '南通市气象台',
        pubTime,
        title,
        startTime: pubTime,
        endTime: '',
        status: this.inferWeatherWarningStatus(title, text),
        level,
        type,
        text,
      });
    }

    return warnings;
  }

  private inferWeatherWarningStatus(title: string, text: string): string {
    return /解除|取消|撤销|结束|终止|失效|过期/.test(`${title} ${text}`)
      ? '解除'
      : '发布';
  }

  private extractFirstMatch(value: string, pattern: RegExp): string {
    return value.match(pattern)?.[1] || '';
  }

  private cleanHtmlText(value: string): string {
    return this.decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  private decodeHtmlEntities(value: string): string {
    const namedEntities: Record<string, string> = {
      nbsp: ' ',
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    };

    return value.replace(
      /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
      (_, entity: string) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith('#')) {
          return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        }
        return namedEntities[entity] || `&${entity};`;
      },
    );
  }

  private mapWeatherWarningColor(color?: string): string {
    const normalized = (color || '').toLowerCase();
    if (normalized.includes('red') || normalized.includes('红')) return '红色';
    if (normalized.includes('orange') || normalized.includes('橙'))
      return '橙色';
    if (normalized.includes('yellow') || normalized.includes('黄'))
      return '黄色';
    if (normalized.includes('blue') || normalized.includes('蓝')) return '蓝色';
    return '';
  }

  private extractWeatherWarningLevel(value: string): string {
    return value.match(/(红色|橙色|黄色|蓝色)预警/)?.[1] || '';
  }

  private extractWeatherWarningType(value: string): string {
    return value.match(/发布(.+?)(?:红色|橙色|黄色|蓝色)?预警/)?.[1] || '';
  }

  /**
   * 获取逐小时天气预报（未来24小时）
   */
  async getWeatherHourly() {
    if (
      this.weatherHourlyCache &&
      this.weatherHourlyCache.expiresAt > Date.now()
    ) {
      return this.weatherHourlyCache.data;
    }

    try {
      if (!this.QWEATHER_KEY) {
        const data = await this.getFallbackWeatherHourly();
        this.weatherHourlyCache = {
          data,
          expiresAt: Date.now() + this.WEATHER_CACHE_TTL_MS,
        };
        return data;
      }
      this.logger.log('开始获取逐小时天气预报');
      const response = await this.httpService.axiosRef.get(
        `${this.QWEATHER_BASE_URL}/weather/24h?location=${this.NANTONG_LOCATION}&key=${this.QWEATHER_KEY}`,
        { timeout: 3000 },
      );

      if (response.data.code !== '200') {
        throw new Error(`逐小时天气API错误: ${response.data.code}`);
      }

      this.logger.log('获取逐小时天气预报成功');
      this.weatherHourlyCache = {
        data: response.data,
        expiresAt: Date.now() + this.WEATHER_CACHE_TTL_MS,
      };
      return response.data;
    } catch (error) {
      this.logger.warn(
        `获取逐小时天气预报失败，尝试使用兜底天气源: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        const data = await this.getFallbackWeatherHourly();
        this.weatherHourlyCache = {
          data,
          expiresAt: Date.now() + this.WEATHER_CACHE_TTL_MS,
        };
        return data;
      } catch (fallbackError) {
        this.logger.warn(
          `兜底逐小时天气源也不可用: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
      // 返回默认数据，避免前端显示错误
      return {
        code: '200',
        hourly: [],
      };
    }
  }

  private async getFallbackWeatherNow() {
    try {
      return await this.getChinaWeatherNow();
    } catch (chinaWeatherError) {
      this.logger.warn(
        `国内兜底天气源不可用，尝试 Open-Meteo: ${chinaWeatherError instanceof Error ? chinaWeatherError.message : String(chinaWeatherError)}`,
      );
      return this.getOpenMeteoWeatherNow();
    }
  }

  private async getFallbackWeatherHourly() {
    try {
      return await this.getChinaWeatherHourly();
    } catch (chinaWeatherError) {
      this.logger.warn(
        `国内兜底逐小时天气源不可用，尝试 Open-Meteo: ${chinaWeatherError instanceof Error ? chinaWeatherError.message : String(chinaWeatherError)}`,
      );
      return this.getOpenMeteoWeatherHourly();
    }
  }

  private async getChinaWeatherNow() {
    const data = await this.fetchChinaWeather();
    const current = data.data;
    if (!current) {
      throw new Error('China weather data is empty');
    }

    const todayForecast = this.getChinaForecastForDate(data, new Date());
    const weather = this.mapChinaWeatherType(todayForecast?.type);
    const windSpeedScale = this.extractWindScale(todayForecast?.fl) || '2';
    const humidity = this.parseHumidity(current.shidu);
    const temp = this.parseTemperatureText(current.wendu, 20);
    const updateDate = data.time || new Date().toISOString();

    return {
      code: '200',
      updateTime: updateDate,
      fxLink: '',
      now: {
        obsTime: updateDate,
        temp: String(Math.round(temp)),
        feelsLike: String(Math.round(temp)),
        icon: weather.icon,
        text: weather.text,
        wind360: '',
        windDir: todayForecast?.fx || '东南风',
        windScale: windSpeedScale,
        windSpeed: '',
        humidity: humidity ? String(humidity) : '70',
        precip: '0.0',
        pressure: '',
        vis: '',
        cloud: '',
        dew: '',
      },
    };
  }

  private async getChinaWeatherHourly() {
    const data = await this.fetchChinaWeather();
    if (!data.data) {
      throw new Error('China weather data is empty');
    }

    const now = new Date();
    const currentTemp = this.parseTemperatureText(data.data.wendu, 20);
    const sourceIndexes = Array.from({ length: 24 }, (_, index) => {
      const date = new Date(now);
      date.setMinutes(0, 0, 0);
      date.setHours(date.getHours() + index);
      return date;
    });

    return {
      code: '200',
      updateTime: data.time || new Date().toISOString(),
      fxLink: '',
      hourly: sourceIndexes.map((date, index) => {
        const forecast = this.getChinaForecastForDate(data, date);
        const weather = this.mapChinaWeatherType(forecast?.type);
        const { low, high } = this.getChinaForecastTemperatureRange(
          forecast,
          currentTemp,
        );
        const temp = this.estimateHourlyTemperature(
          date,
          currentTemp,
          low,
          high,
          index,
        );
        return {
          fxTime: this.formatShanghaiHour(date),
          temp: String(Math.round(temp)),
          icon: weather.icon,
          text: weather.text,
          wind360: '',
          windDir: forecast?.fx || '东南风',
          windScale: this.extractWindScale(forecast?.fl) || '2',
          windSpeed: '',
          humidity: this.parseHumidity(data.data?.shidu)
            ? String(this.parseHumidity(data.data?.shidu))
            : '70',
          precip: '0.0',
          pop: '0',
          pressure: '',
          cloud: '',
          dew: '',
        };
      }),
    };
  }

  private async fetchChinaWeather(): Promise<ChinaWeatherResponse> {
    const response = await this.httpService.axiosRef.get<ChinaWeatherResponse>(
      `${this.CHINA_WEATHER_BASE_URL}/${this.CHINA_WEATHER_CITY_ID}`,
      { timeout: 3000 },
    );
    if (response.data.status !== 200 || !response.data.data) {
      throw new Error(
        `China weather API error: ${response.data.status || 'empty'}`,
      );
    }
    return response.data;
  }

  private async getOpenMeteoWeatherNow() {
    const data = await this.fetchOpenMeteoForecast();
    const current = data.current;
    if (!current) {
      throw new Error('Open-Meteo current weather is empty');
    }

    const weather = this.mapOpenMeteoWeatherCode(current.weather_code);
    const windDirection = this.formatWindDirection(current.wind_direction_10m);
    const windSpeed = this.toFiniteNumber(current.wind_speed_10m, 0);

    return {
      code: '200',
      updateTime: new Date().toISOString(),
      fxLink: '',
      now: {
        obsTime: current.time || new Date().toISOString(),
        temp: String(
          Math.round(this.toFiniteNumber(current.temperature_2m, 0)),
        ),
        feelsLike: String(
          Math.round(this.toFiniteNumber(current.temperature_2m, 0)),
        ),
        icon: weather.icon,
        text: weather.text,
        wind360: String(
          Math.round(this.toFiniteNumber(current.wind_direction_10m, 0)),
        ),
        windDir: windDirection,
        windScale: this.formatWindScale(windSpeed),
        windSpeed: String(Math.round(windSpeed)),
        humidity: String(
          Math.round(this.toFiniteNumber(current.relative_humidity_2m, 0)),
        ),
        precip: '0.0',
        pressure: '',
        vis: '',
        cloud: '',
        dew: '',
      },
    };
  }

  private async getOpenMeteoWeatherHourly() {
    const data = await this.fetchOpenMeteoForecast();
    const hourly = data.hourly;
    if (!hourly?.time?.length) {
      throw new Error('Open-Meteo hourly weather is empty');
    }

    const currentHourStart = new Date();
    currentHourStart.setMinutes(0, 0, 0);
    const currentHourKey =
      [
        currentHourStart.getFullYear(),
        String(currentHourStart.getMonth() + 1).padStart(2, '0'),
        String(currentHourStart.getDate()).padStart(2, '0'),
      ].join('-') +
      `T${String(currentHourStart.getHours()).padStart(2, '0')}:00`;

    const hourlyIndexes = hourly.time
      .map((time, index) => ({ time, index }))
      .filter(({ time }) => time >= currentHourKey)
      .slice(0, 24);
    const sourceIndexes =
      hourlyIndexes.length > 0
        ? hourlyIndexes
        : hourly.time.slice(0, 24).map((time, index) => ({ time, index }));

    return {
      code: '200',
      updateTime: new Date().toISOString(),
      fxLink: '',
      hourly: sourceIndexes.map(({ time, index }) => {
        const weather = this.mapOpenMeteoWeatherCode(
          hourly.weather_code?.[index],
        );
        const windSpeed = this.toFiniteNumber(
          hourly.wind_speed_10m?.[index],
          0,
        );
        return {
          fxTime: time,
          temp: String(
            Math.round(this.toFiniteNumber(hourly.temperature_2m?.[index], 0)),
          ),
          icon: weather.icon,
          text: weather.text,
          wind360: String(
            Math.round(
              this.toFiniteNumber(hourly.wind_direction_10m?.[index], 0),
            ),
          ),
          windDir: this.formatWindDirection(hourly.wind_direction_10m?.[index]),
          windScale: this.formatWindScale(windSpeed),
          windSpeed: String(Math.round(windSpeed)),
          humidity: String(
            Math.round(
              this.toFiniteNumber(hourly.relative_humidity_2m?.[index], 0),
            ),
          ),
          precip: '0.0',
          pop: '0',
          pressure: '',
          cloud: '',
          dew: '',
        };
      }),
    };
  }

  private async fetchOpenMeteoForecast(): Promise<OpenMeteoForecastResponse> {
    const { latitude, longitude } = this.getNantongLatLon();
    const response =
      await this.httpService.axiosRef.get<OpenMeteoForecastResponse>(
        'https://api.open-meteo.com/v1/forecast',
        {
          params: {
            latitude,
            longitude,
            current:
              'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m',
            hourly:
              'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m',
            timezone: 'Asia/Shanghai',
            forecast_days: 2,
          },
          timeout: 3000,
        },
      );
    return response.data;
  }

  private getNantongLatLon(): { latitude: number; longitude: number } {
    const [longitude, latitude] = this.NANTONG_LOCATION.split(',').map(Number);
    return {
      latitude: Number.isFinite(latitude) ? latitude : 32.03,
      longitude: Number.isFinite(longitude) ? longitude : 120.86,
    };
  }

  private getChinaForecastForDate(
    data: ChinaWeatherResponse,
    date: Date,
  ): ChinaWeatherForecastItem | undefined {
    const forecast = data.data?.forecast || [];
    const dateKey = this.formatDateOnly(date);
    return forecast.find((item) => item.ymd === dateKey) || forecast[0];
  }

  private getChinaForecastTemperatureRange(
    forecast: ChinaWeatherForecastItem | undefined,
    fallbackTemp: number,
  ): { low: number; high: number } {
    const low = this.parseTemperatureText(forecast?.low, fallbackTemp - 3);
    const high = this.parseTemperatureText(forecast?.high, fallbackTemp + 3);
    return {
      low: Math.min(low, high),
      high: Math.max(low, high),
    };
  }

  private estimateHourlyTemperature(
    date: Date,
    currentTemp: number,
    low: number,
    high: number,
    offsetHours: number,
  ): number {
    const hour = date.getHours() + date.getMinutes() / 60;
    const daytimeProgress = Math.max(0, Math.min(1, (hour - 5) / 10));
    const coolingProgress = Math.max(0, Math.min(1, (hour - 15) / 9));
    const warmingCurve = Math.sin((daytimeProgress * Math.PI) / 2);
    const coolingCurve = 1 - coolingProgress * 0.7;
    const target =
      low + (high - low) * Math.max(0.15, warmingCurve * coolingCurve);
    const blend = Math.min(1, offsetHours / 6);
    return currentTemp * (1 - blend) + target * blend;
  }

  private parseTemperatureText(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const matched = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
    const parsed = matched ? Number.parseFloat(matched[0]) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private parseHumidity(value: unknown): number | null {
    const matched = String(value ?? '').match(/\d+(?:\.\d+)?/);
    const parsed = matched ? Number.parseFloat(matched[0]) : Number.NaN;
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }

  private extractWindScale(value: unknown): string | null {
    const matched = String(value ?? '').match(/\d+/);
    return matched ? matched[0] : null;
  }

  private formatDateOnly(date: Date): string {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }

  private formatShanghaiHour(date: Date): string {
    return `${this.formatDateOnly(date)}T${String(date.getHours()).padStart(2, '0')}:00:00+08:00`;
  }

  private mapChinaWeatherType(type: string | undefined): {
    text: string;
    icon: string;
  } {
    const value = type || '多云';
    if (value.includes('晴')) return { text: value, icon: '100' };
    if (value.includes('多云')) return { text: value, icon: '101' };
    if (value.includes('阴')) return { text: value, icon: '104' };
    if (value.includes('雷')) return { text: value, icon: '302' };
    if (value.includes('雨'))
      return { text: value, icon: value.includes('阵') ? '306' : '305' };
    if (value.includes('雪')) return { text: value, icon: '400' };
    if (value.includes('雾')) return { text: value, icon: '501' };
    return { text: value, icon: '101' };
  }

  private mapOpenMeteoWeatherCode(code: number | undefined): {
    text: string;
    icon: string;
  } {
    if (code === 0) return { text: '晴', icon: '100' };
    if (code === 1 || code === 2) return { text: '多云', icon: '101' };
    if (code === 3) return { text: '阴', icon: '104' };
    if (code === 45 || code === 48) return { text: '雾', icon: '501' };
    if (code !== undefined && code >= 51 && code <= 67)
      return { text: '小雨', icon: '305' };
    if (code !== undefined && code >= 71 && code <= 77)
      return { text: '雪', icon: '400' };
    if (code !== undefined && code >= 80 && code <= 82)
      return { text: '阵雨', icon: '306' };
    if (code !== undefined && code >= 95)
      return { text: '雷阵雨', icon: '302' };
    return { text: '天气待更新', icon: '999' };
  }

  private formatWindDirection(degree: number | undefined): string {
    const value = this.toFiniteNumber(degree, 0);
    const directions = [
      '北风',
      '东北风',
      '东风',
      '东南风',
      '南风',
      '西南风',
      '西风',
      '西北风',
    ];
    return directions[Math.round(value / 45) % directions.length];
  }

  private formatWindScale(speedKmh: number): string {
    const thresholds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
    const scale = thresholds.findIndex((threshold) => speedKmh < threshold);
    return String(scale === -1 ? 12 : scale);
  }

  private toFiniteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : fallback;
  }
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  const normalize = (value: string) =>
    value.trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
  const leftKeys = new Set(Array.from(left, normalize).filter(Boolean));
  const rightKeys = new Set(Array.from(right, normalize).filter(Boolean));
  return (
    leftKeys.size === rightKeys.size &&
    Array.from(leftKeys).every((value) => rightKeys.has(value))
  );
}
