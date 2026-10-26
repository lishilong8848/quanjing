import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, Optional } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import FormData = require('form-data');
import { createHash } from 'node:crypto';
import {
  extractDisplayText,
  extractDisplayValues,
  fetchBitableRecords,
  getRecordId,
  getTenantAccessToken,
  invalidateBitableRecordCache,
  pickField,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '@server/common/feishu/bitable-direct-read';
import { readEnv } from '@server/common/config/external-services.config';
import type { AttendanceAnomalyCard } from './attendance-automation.card';
import {
  attendanceBusinessKey,
  attendanceFieldsMatch,
  reconcileAttendanceRows,
} from './attendance-archive-reconciliation';
import {
  withAttendanceArchiveClaim,
  persistAttendanceDedupBackup,
} from './attendance-archive-journal';
import {
  fetchLeaveApprovalSnapshot,
  readCachedLeaveApprovalSnapshotState,
  resolveLeaveApprovalSource,
  type ApprovedLeaveRequest,
} from '@server/common/feishu/leave-approval-source';
import { ATTENDANCE_OVERTIME_FIELDS } from './attendance-overtime';
import type {
  AttendanceAnomaly,
  AttendanceExpectation,
} from './attendance-automation.rules';
import { classifyAttendanceExpectations } from './attendance-automation.rules';
import type { AttendanceAutomationTask } from './attendance-automation.scheduler';
import type {
  DingTalkAttendanceRawDetail,
  DingTalkAttendanceRawResult,
  DingTalkCorrectionApproval,
  DingTalkDirectoryUser,
} from './dingtalk-attendance.client';
import type {
  TodayAttendanceCorrectionEvidenceManifest,
  TodayAttendanceCorrectionEvidenceQuery,
} from '@shared/today-attendance.interface';
import { AttendanceCorrectionEvidenceStorageService } from './attendance-correction-evidence-storage.service';
import { excludesApprovedLeave } from './attendance-approved-leave';

const DEFAULT_ATTENDANCE_APP_TOKEN = 'PUBLIC_EXAMPLE_FEISHU_MAIN_APP_TOKEN';
const DEFAULT_ATTENDANCE_TABLE_ID = 'tbl01cda9acd2f8f';
const DEFAULT_PERSONNEL_APP_TOKEN = 'PUBLIC_EXAMPLE_FEISHU_ORG_APP_TOKEN';
const DEFAULT_PERSONNEL_TABLE_ID = 'PUBLIC_EXAMPLE_FEISHU_ORG_TABLE_ID';
const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';
const MAX_CORRECTION_IMAGE_BYTES = 10 * 1024 * 1024;
const CONFIRMED_MANAGER_APP_ID = 'cli_0831564613853b26';
const CONFIRMED_MANAGER_OPEN_ID = 'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID';

export interface AttendanceSyncFailureAlert {
  task: AttendanceAutomationTask;
  date: string;
  stage: 'archive' | 'correction';
  detail: string;
}

export interface AttendanceRecipient {
  openId: string;
  name: string;
  scope: 'manager' | 'building' | 'station';
  building?: string;
}

export interface AttendancePersonalRecipient {
  openId: string;
  name: string;
}

export interface AttendancePersonalRecipientResolution {
  recipients: AttendancePersonalRecipient[];
  failures: string[];
}

export interface ArchivedAttendanceSummary {
  archiveRecordCount?: number;
  businessDate: string;
  fetchedAt: string;
  hasArchivedResult: boolean;
  anomalies: AttendanceAnomaly[];
  normal: AttendanceExpectation[];
  normalByBuilding: Record<string, number>;
  checkedTasks: Array<Exclude<AttendanceAutomationTask, 'archive-yesterday'>>;
}

export interface ArchivedAttendancePeriodSummary {
  startDate: string;
  endDate: string;
  fetchedAt: string;
  checkedCount: number;
  anomalies: Array<AttendanceAnomaly & { businessDate: string }>;
  normal: AttendanceExpectation[];
  corrected: Array<AttendanceExpectation & { businessDate: string }>;
}

export interface ArchivedAttendanceRecheckTarget {
  businessDate: string;
  userId: string;
  expectation: AttendanceExpectation;
}

export type ArchivedAttendanceCoverage = Record<string, string[]>;

interface PersonnelDirectoryRecord {
  name: string;
  openIds: string[];
  position: string;
  building: string;
  departed: boolean;
}

interface CorrectionEvidenceRecord extends Omit<
  TodayAttendanceCorrectionEvidenceManifest,
  'failureReason' | 'images' | 'retryAfterMs' | 'syncState'
> {
  appToken: string;
  tableId: string;
  recordId: string;
  processInstanceId: string;
  fileTokens: string[];
}

interface ArchiveInput {
  businessDate: string;
  users: readonly DingTalkDirectoryUser[];
  results: readonly DingTalkAttendanceRawResult[];
  details: readonly DingTalkAttendanceRawDetail[];
  corrections?: readonly DingTalkCorrectionApproval[];
}

interface ArchiveRow {
  recordId?: string;
  key: string;
  fields: Record<string, unknown>;
  expectedEvidenceCount?: number;
  expectationKey?: string;
}

@Injectable()
export class AttendanceAutomationFeishuGateway {
  private readonly logger = new Logger(AttendanceAutomationFeishuGateway.name);
  private readonly correctionEvidenceCache = new Map<
    string,
    { expiresAt: number; record: CorrectionEvidenceRecord }
  >();
  private readonly correctionEvidenceMigrations = new Map<
    string,
    | { state: 'running' }
    | { state: 'failed'; failureReason: string; retryAt: number }
  >();
  private readonly correctionEvidenceFieldIdCache = new Map<string, string>();

  constructor(
    private readonly httpService: HttpService,
    @Optional()
    private readonly correctionEvidenceStorage?: AttendanceCorrectionEvidenceStorageService,
  ) {}

  async readApprovedAttendanceLeave(): Promise<ApprovedLeaveRequest[]> {
    const snapshot = await fetchLeaveApprovalSnapshot(this.httpService, {
      forceRefresh: true,
      strict: true,
    });
    if (!snapshot.verified)
      throw new Error('请休假审批数据未核验，暂停考勤异常通知');
    return snapshot.requests;
  }

  async readApprovedAttendanceLeaveForDisplay(): Promise<ApprovedLeaveRequest[]> {
    const cached = await readCachedLeaveApprovalSnapshotState();
    const now = Date.now();
    const isRecent = (fetchedAt: number | null): boolean =>
      fetchedAt !== null &&
      Number.isFinite(fetchedAt) &&
      fetchedAt <= now &&
      now - fetchedAt < 60_000;
    if (
      cached.snapshot.verified &&
      isRecent(cached.approvalFetchedAt) &&
      (cached.shiftDetailFetchedAt === null ||
        isRecent(cached.shiftDetailFetchedAt))
    ) {
      return cached.snapshot.requests;
    }
    return this.readApprovedAttendanceLeave();
  }

  async readAttendanceOvertimeRecords(): Promise<BitableRecordItem[]> {
    const source = resolveLeaveApprovalSource();
    const appToken = await resolveBitableAppToken(this.httpService, {
      ...source,
      tableName: '考勤加班审批',
    });
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId: source.tableId,
      tableName: '考勤加班审批',
      fieldNames: ATTENDANCE_OVERTIME_FIELDS,
      forceRefresh: true,
      allowStale: false,
      strict: true,
    });
    const people = await this.listActivePersonnel();
    return records.map((record) => {
      const fields = record.fields || {};
      const users = Array.isArray(fields.加班人员) ? fields.加班人员 : [];
      const ids = users.flatMap((user) =>
        typeof (user?.open_id || user?.id) === 'string'
          ? [user.open_id || user.id]
          : [],
      );
      const matches = people.filter((person) =>
        person.openIds.some((id) => ids.includes(id)),
      );
      const buildings = [
        ...new Set(matches.map((person) => person.building).filter(Boolean)),
      ];
      return {
        ...record,
        fields: { ...fields, 机楼: buildings.length === 1 ? buildings[0] : '' },
      };
    });
  }

  async archiveAttendance(input: ArchiveInput): Promise<{
    total: number;
    created: number;
    updated: number;
  }> {
    return withAttendanceArchiveClaim(() =>
      this.archiveAttendanceUnderLock(input),
    );
  }

  async reconcileApprovedLeaveMissingPunches(
    businessDates: readonly string[],
    approvedLeave: readonly ApprovedLeaveRequest[],
  ): Promise<number> {
    if (businessDates.length === 0 || approvedLeave.length === 0) return 0;
    businessDates.forEach(assertDateKey);
    return withAttendanceArchiveClaim(async () => {
      const appToken =
        readEnv('FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN') ||
        DEFAULT_ATTENDANCE_APP_TOKEN;
      const tableId =
        readEnv('FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID') ||
        DEFAULT_ATTENDANCE_TABLE_ID;
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId,
        tableName: '钉钉考勤归档',
        automaticFields: true,
        forceRefresh: true,
        strict: true,
      });
      const recordIds = findApprovedLeaveMissingPunchRecordIds(
        records,
        businessDates,
        approvedLeave,
      );
      if (!recordIds.length) return 0;
      persistAttendanceDedupBackup({
        version: 1,
        reason: 'approved-leave-missing-punch',
        tableId,
        capturedAt: new Date().toISOString(),
        originals: records.filter((record) =>
          recordIds.includes(getRecordId(record)),
        ),
        deleteRecordIds: recordIds,
      });
      const token = await getTenantAccessToken(this.httpService);
      for (const batch of chunks(recordIds, 500)) {
        const response = await this.httpService.axiosRef.post(
          `${recordsUrl(appToken, tableId)}/batch_delete`,
          { records: batch },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 },
        );
        const deleted = new Set<string>(
          (response.data?.data?.records || [])
            .filter((item: { deleted?: boolean }) => item.deleted === true)
            .map((item: { record_id: string }) => item.record_id),
        );
        if (
          Number(response.data?.code) !== 0 ||
          batch.some((id) => !deleted.has(id))
        ) {
          throw new Error('已审批请假缺卡误报删除未全部确认，备份已保留');
        }
      }
      invalidateBitableRecordCache({ appToken, tableId });
      const verified = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId,
        tableName: '钉钉考勤归档',
        automaticFields: true,
        forceRefresh: true,
        strict: true,
      });
      const remaining = new Set(verified.map(getRecordId));
      if (recordIds.some((id) => remaining.has(id))) {
        throw new Error('已审批请假缺卡误报删除回读不一致，备份已保留');
      }
      return recordIds.length;
    });
  }

  private async archiveAttendanceUnderLock(input: ArchiveInput): Promise<{
    total: number;
    created: number;
    updated: number;
  }> {
    const appToken =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN') ||
      DEFAULT_ATTENDANCE_APP_TOKEN;
    const tableId =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID') ||
      DEFAULT_ATTENDANCE_TABLE_ID;
    const attendanceRows = buildArchiveRows(input);
    const corrections = input.corrections || [];
    if (attendanceRows.length === 0 && corrections.length === 0) {
      return { total: 0, created: 0, updated: 0 };
    }

    const existingRecords = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName: '钉钉考勤归档',
      automaticFields: true,
      forceRefresh: true,
      strict: true,
    });
    const existingByKey = new Map<string, BitableRecordItem>(
      existingRecords
        .map((record): [string, BitableRecordItem] => [
          extractDisplayText(
            pickField(record.fields || {}, ['记录唯一键']),
            '',
          ).trim(),
          record,
        ])
        .filter(([key, record]) => Boolean(key && getRecordId(record))),
    );
    const existingByExpectationKey =
      buildLatestExistingByExpectationKey(existingRecords);
    const token = await getTenantAccessToken(this.httpService);
    const correctionRows = await this.buildCorrectionRows({
      input,
      corrections,
      appToken,
      token,
      existingByKey,
    });
    const reconciliation = reconcileAttendanceRows(
      attendanceRows,
      existingRecords,
    );
    const rows: ArchiveRow[] = [...reconciliation.rows, ...correctionRows];
    if (reconciliation.duplicates.length) {
      persistAttendanceDedupBackup({
        version: 1,
        tableId,
        capturedAt: new Date().toISOString(),
        originals: reconciliation.originals,
        keepers: reconciliation.rows.filter((row) => row.recordId),
        deleteRecordIds: reconciliation.duplicates.map(getRecordId),
      });
    }
    const creates: Array<{ fields: Record<string, unknown> }> = [];
    const updates: Array<{
      record_id: string;
      fields: Record<string, unknown>;
    }> = [];
    rows.forEach((row) => {
      const existing =
        existingByKey.get(row.key) ||
        (row.expectationKey
          ? existingByExpectationKey.get(row.expectationKey)
          : undefined);
      const recordId = row.recordId || (existing ? getRecordId(existing) : '');
      if (recordId) updates.push({ record_id: recordId, fields: row.fields });
      else creates.push({ fields: row.fields });
    });

    for (const batch of chunks(creates, 500)) {
      await this.postBitableBatch(
        `${recordsUrl(appToken, tableId)}/batch_create`,
        { records: batch },
        token,
      );
    }
    for (const batch of chunks(updates, 500)) {
      await this.postBitableBatch(
        `${recordsUrl(appToken, tableId)}/batch_update`,
        { records: batch },
        token,
      );
    }

    invalidateBitableRecordCache({ appToken, tableId });
    const verified = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName: '钉钉考勤归档',
      automaticFields: true,
      forceRefresh: true,
      strict: true,
    });
    const verifiedByKey = new Map(
      verified.map((record) => [
        extractDisplayText(record.fields?.['记录唯一键'], '').trim(),
        record,
      ]),
    );
    const verifiedByRecordId = new Map(
      verified.map((record) => [getRecordId(record), record]),
    );
    const verifiedRow = (row: ArchiveRow) =>
      row.recordId
        ? verifiedByRecordId.get(row.recordId)
        : verifiedByKey.get(row.key);
    const missingKeys = rows.filter((row) => {
      const record = verifiedRow(row);
      return (
        !record ||
        extractDisplayText(record.fields?.['记录唯一键'], '').trim() !== row.key
      );
    });
    if (missingKeys.length > 0) {
      throw new Error(
        `飞书考勤归档语义回读失败：${missingKeys.length} 条唯一键未落表`,
      );
    }
    const missingEvidence = rows.filter(
      (row) =>
        row.expectedEvidenceCount &&
        extractAttachmentTokens(verifiedRow(row)?.fields?.['补卡举证材料'])
          .length !== row.expectedEvidenceCount,
    );
    if (missingEvidence.length > 0) {
      throw new Error(
        `飞书补卡举证材料语义回读失败：${missingEvidence.length} 条记录无附件`,
      );
    }
    const mismatched = rows.filter(
      (row) =>
        attendanceBusinessKey(row.fields) &&
        !attendanceFieldsMatch(row.fields, verifiedRow(row)?.fields || {}),
    );
    if (mismatched.length)
      throw new Error(
        `飞书考勤归档语义回读失败：${mismatched.length} 条打卡字段不一致，未删除重复行`,
      );
    // Delete only the snapshotted duplicates after the exact keeper passed semantic readback.
    for (const batch of chunks(
      reconciliation.duplicates.map(getRecordId),
      500,
    )) {
      const response = await this.httpService.axiosRef.post(
        `${recordsUrl(appToken, tableId)}/batch_delete`,
        { records: batch },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 },
      );
      const data = response.data;
      const deleted = new Set<string>(
        (data?.data?.records || [])
          .filter((item: { deleted?: boolean }) => item.deleted === true)
          .map((item: { record_id: string }) => item.record_id),
      );
      if (Number(data?.code) !== 0 || batch.some((id) => !deleted.has(id))) {
        throw new Error(
          '飞书考勤重复行删除未全部确认；原始备份已保留，下次同步可继续收口',
        );
      }
    }
    if (reconciliation.duplicates.length)
      invalidateBitableRecordCache({ appToken, tableId });
    return {
      total: rows.length,
      created: creates.length,
      updated: updates.length,
    };
  }

  async resolveRecipients(
    task: Exclude<AttendanceAutomationTask, 'archive-yesterday'>,
    buildings: readonly string[],
  ): Promise<AttendanceRecipient[]> {
    const people = await this.listActivePersonnel();
    const recipients: AttendanceRecipient[] = [];
    const normalizedBuildings = new Set(
      buildings.map(normalizeBuilding).filter(Boolean),
    );
    const hasCampusBuilding = [...normalizedBuildings].some(
      (building) => building !== '110站',
    );

    if (hasCampusBuilding) {
      const managerName = readEnv('FEISHU_ATTENDANCE_MANAGER_NAME') || '示例人员020';
      people
        .filter((person) => person.name === managerName)
        .forEach((person) =>
          person.openIds.forEach((openId) =>
            recipients.push({ openId, name: person.name, scope: 'manager' }),
          ),
        );
    }

    if (normalizedBuildings.has('110站')) {
      const stationName =
        readEnv('FEISHU_ATTENDANCE_STATION_SUPERVISOR_NAME') || '示例人员006';
      people
        .filter((person) => person.name === stationName)
        .forEach((person) =>
          person.openIds.forEach((openId) =>
            recipients.push({
              openId,
              name: person.name,
              scope: 'station',
              building: '110站',
            }),
          ),
        );
    }

    const supervisorBuildings = new Set(
      [...normalizedBuildings].filter(
        (building) => building !== 'H楼' && building !== '110站',
      ),
    );
    people
      .filter(
        (person) =>
          person.position.includes('示例人员001') &&
          supervisorBuildings.has(person.building),
      )
      .forEach((person) =>
        person.openIds.forEach((openId) =>
          recipients.push({
            openId,
            name: person.name,
            scope: 'building',
            building: person.building,
          }),
        ),
      );

    const deduped = new Map<string, AttendanceRecipient>();
    recipients.forEach((recipient) => {
      const current = deduped.get(recipient.openId);
      if (!current || current.scope !== 'manager') {
        deduped.set(recipient.openId, recipient);
      }
    });
    const result = [...deduped.values()];
    if (result.length === 0) {
      throw new Error(`考勤异常卡片未解析到收件人：task=${task}`);
    }
    return result;
  }

  async readArchivedAttendanceSummary(
    businessDate: string,
  ): Promise<ArchivedAttendanceSummary> {
    assertDateKey(businessDate);
    const appToken =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN') ||
      DEFAULT_ATTENDANCE_APP_TOKEN;
    const tableId =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID') ||
      DEFAULT_ATTENDANCE_TABLE_ID;
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName: '钉钉考勤归档',
      automaticFields: true,
      fieldNames: [
        '记录类型',
        '姓名',
        '工作日期',
        '打卡类型',
        '应打卡时间',
        '实际打卡时间',
        '时间状态',
        '是否合法',
        '补卡异常说明',
        '原始记录JSON',
        '同步时间',
      ],
      forceRefresh: true,
      strict: true,
    });
    return {
      ...buildArchivedAttendanceSummary(businessDate, records),
      archiveRecordCount: records.length,
    };
  }

  async readArchivedAttendancePeriod(
    startDate: string,
    endDate: string,
    forceRefresh = true,
  ): Promise<ArchivedAttendancePeriodSummary> {
    assertDateKey(startDate);
    assertDateKey(endDate);
    if (startDate > endDate) throw new Error('考勤通晒日期范围无效');
    const appToken =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN') ||
      DEFAULT_ATTENDANCE_APP_TOKEN;
    const tableId =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID') ||
      DEFAULT_ATTENDANCE_TABLE_ID;
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName: '钉钉考勤归档',
      automaticFields: true,
      fieldNames: [
        '记录类型',
        '姓名',
        '工作日期',
        '打卡类型',
        '应打卡时间',
        '实际打卡时间',
        '时间状态',
        '是否合法',
        '补卡异常说明',
        '原始记录JSON',
        '同步时间',
      ],
      filter: {
        conjunction: 'and',
        conditions: [
          {
            field_name: '工作日期',
            operator: 'isGreater',
            value: ['ExactDate', String(Date.parse(`${startDate}T00:00:00+08:00`) - 86_400_000)],
          },
          {
            field_name: '工作日期',
            operator: 'isLess',
            value: ['ExactDate', String(Date.parse(`${endDate}T00:00:00+08:00`) + 86_400_000)],
          },
        ],
      },
      cacheTtlMs: 2 * 60 * 1_000,
      forceRefresh,
      allowStale: false,
      strict: true,
    });
    return buildArchivedAttendancePeriodSummary(startDate, endDate, records);
  }

  async readArchivedAttendanceRecheckTargets(
    businessDates: readonly string[],
  ): Promise<ArchivedAttendanceRecheckTarget[]> {
    const dates = [...new Set(businessDates.map((date) => date.trim()))];
    dates.forEach(assertDateKey);
    if (dates.length === 0) return [];
    const appToken =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN') ||
      DEFAULT_ATTENDANCE_APP_TOKEN;
    const tableId =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID') ||
      DEFAULT_ATTENDANCE_TABLE_ID;
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName: '钉钉考勤归档',
      automaticFields: true,
      fieldNames: [
        '记录类型',
        '钉钉员工ID',
        '姓名',
        '工作日期',
        '应打卡时间',
        '时间状态',
        '是否合法',
        '补卡异常说明',
        '原始记录JSON',
        '同步时间',
      ],
      forceRefresh: true,
      allowStale: false,
      strict: true,
    });
    const dateSet = new Set(dates);
    return buildLatestArchivedResultRecords(records)
      .filter(
        (item) =>
          dateSet.has(item.businessDate) && Boolean(item.reason && item.userId),
      )
      .map((item) => ({
        businessDate: item.businessDate,
        userId: item.userId,
        expectation: item.expectation,
      }));
  }

  async readArchivedAttendanceCoverage(
    businessDates: readonly string[],
  ): Promise<ArchivedAttendanceCoverage> {
    const dates = [...new Set(businessDates.map((date) => date.trim()))];
    dates.forEach(assertDateKey);
    const coverage: ArchivedAttendanceCoverage = Object.fromEntries(
      dates.map((date) => [date, []]),
    );
    if (dates.length === 0) return coverage;

    const appToken =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN') ||
      DEFAULT_ATTENDANCE_APP_TOKEN;
    const tableId =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID') ||
      DEFAULT_ATTENDANCE_TABLE_ID;
    const dateSet = new Set(dates);
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName: '钉钉考勤归档',
      fieldNames: ['记录类型', '工作日期', '原始记录JSON'],
      forceRefresh: true,
      strict: true,
    });
    const keysByDate = new Map<string, Set<string>>(
      dates.map((date) => [date, new Set<string>()]),
    );
    records.forEach((record) => {
      const fields = record.fields || {};
      if (
        extractDisplayText(pickField(fields, ['记录类型'])).trim() !==
        '考勤结果'
      ) {
        return;
      }
      const date = formatShanghaiDateFromValue(pickField(fields, ['工作日期']));
      if (!dateSet.has(date)) return;
      const expectation = parseArchivedExpectation(fields);
      if (expectation) keysByDate.get(date)?.add(expectation.key);
    });
    keysByDate.forEach((keys, date) => {
      coverage[date] = [...keys];
    });
    return coverage;
  }

  async readCorrectionEvidence(
    query: TodayAttendanceCorrectionEvidenceQuery,
  ): Promise<TodayAttendanceCorrectionEvidenceManifest> {
    const evidence = await this.loadCorrectionEvidence(query);
    const proxyManifest = () =>
      this.correctionEvidenceManifest(evidence, {
        syncState: 'ready',
        images: evidence.fileTokens.map(() => ({
          transport: 'proxy',
          url: '',
          contentType: 'image/jpeg',
          expiresAt: '',
        })),
      });
    let storage: AttendanceCorrectionEvidenceStorageService;
    let storedImages: Array<
      Awaited<
        ReturnType<AttendanceCorrectionEvidenceStorageService['getStored']>
      >
    >;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      storage = this.requireCorrectionEvidenceStorage();
      storedImages = await Promise.race([
        Promise.all(
          evidence.fileTokens.map((_fileToken, index) =>
            storage.getStored({
              processInstanceId: evidence.processInstanceId,
              index,
            }),
          ),
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('举证存储读取超时')), 1_000);
        }),
      ]);
    } catch {
      // The existing authenticated read-only media route remains authoritative.
      return proxyManifest();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (storedImages.every(Boolean)) {
      return this.correctionEvidenceManifest(evidence, {
        syncState: 'ready',
        images: storedImages.filter(
          (image): image is NonNullable<typeof image> => Boolean(image),
        ),
      });
    }
    const migrationKey = evidence.processInstanceId;
    const migration = this.correctionEvidenceMigrations.get(migrationKey);
    if (migration?.state === 'failed' && migration.retryAt > Date.now()) {
      return proxyManifest();
    }
    this.startCorrectionEvidenceMigration(evidence);
    return proxyManifest();
  }

  private correctionEvidenceManifest(
    evidence: CorrectionEvidenceRecord,
    state: Pick<
      TodayAttendanceCorrectionEvidenceManifest,
      'failureReason' | 'images' | 'retryAfterMs' | 'syncState'
    >,
  ): TodayAttendanceCorrectionEvidenceManifest {
    const {
      appToken: _appToken,
      tableId: _tableId,
      recordId: _recordId,
      fileTokens: _fileTokens,
      processInstanceId: _processInstanceId,
      ...manifest
    } = evidence;
    return { ...manifest, ...state };
  }

  private startCorrectionEvidenceMigration(
    evidence: CorrectionEvidenceRecord,
  ): void {
    const migrationKey = evidence.processInstanceId;
    if (
      this.correctionEvidenceMigrations.get(migrationKey)?.state === 'running'
    ) {
      return;
    }
    this.correctionEvidenceMigrations.set(migrationKey, { state: 'running' });
    const storage = this.requireCorrectionEvidenceStorage();
    void Promise.all(
      evidence.fileTokens.map((fileToken, index) =>
        storage.ensureStored(
          { processInstanceId: evidence.processInstanceId, index },
          () => this.downloadFeishuCorrectionEvidence(evidence, fileToken),
        ),
      ),
    )
      .then(() => {
        this.correctionEvidenceMigrations.delete(migrationKey);
      })
      .catch((error: unknown) => {
        const failureReason = correctionEvidencePublicFailureReason(error);
        this.correctionEvidenceMigrations.set(migrationKey, {
          state: 'failed',
          failureReason,
          retryAt: Date.now() + 30_000,
        });
        this.logger.error(
          `补卡举证后台迁移失败：process=${createHash('sha256').update(migrationKey).digest('hex').slice(0, 12)}, error=${failureReason}`,
        );
      });
  }

  async downloadCorrectionEvidence(
    query: TodayAttendanceCorrectionEvidenceQuery,
    index: number,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const evidence = await this.loadCorrectionEvidence(query);
    const fileToken = evidence.fileTokens[index];
    if (!fileToken) throw new Error('补卡举证图片不存在');
    const { buffer, contentType } = await this.downloadFeishuCorrectionEvidence(
      evidence,
      fileToken,
    );
    const extension =
      contentType === 'image/png'
        ? 'png'
        : contentType === 'image/webp'
          ? 'webp'
          : contentType === 'image/gif'
            ? 'gif'
            : 'jpg';
    return {
      buffer,
      contentType,
      fileName: `attendance-correction-evidence-${index + 1}.${extension}`,
    };
  }

  async resolvePersonalRecipients(
    anomalies: readonly { name: string; building: string }[],
  ): Promise<AttendancePersonalRecipient[]> {
    const resolution =
      await this.resolvePersonalRecipientsBestEffort(anomalies);
    if (resolution.failures.length > 0) {
      throw new Error(
        `考勤异常个人卡片收件人解析失败：${resolution.failures.join('、')}`,
      );
    }
    return resolution.recipients;
  }

  async resolvePersonalRecipientsBestEffort(
    anomalies: readonly { name: string; building: string }[],
  ): Promise<AttendancePersonalRecipientResolution> {
    if (anomalies.length === 0) return { recipients: [], failures: [] };
    const people = await this.listActivePersonnel();
    const recipients = new Map<string, AttendancePersonalRecipient>();
    const resolutionErrors: string[] = [];
    const anomalyScopes = new Map<string, { name: string; building: string }>();
    anomalies.forEach((anomaly) => {
      const normalizedName = normalizeName(anomaly.name);
      if (!normalizedName) return;
      const building = normalizeBuilding(anomaly.building);
      anomalyScopes.set(`${normalizedName}:${building}`, {
        name: anomaly.name.trim(),
        building,
      });
    });

    anomalyScopes.forEach((anomaly) => {
      const nameMatches = people.filter(
        (person) => normalizeName(person.name) === normalizeName(anomaly.name),
      );
      const buildingMatches = anomaly.building
        ? nameMatches.filter((person) => person.building === anomaly.building)
        : [];
      const candidates =
        buildingMatches.length > 0 ? buildingMatches : nameMatches;
      const openIds = [
        ...new Set(candidates.flatMap((person) => person.openIds)),
      ];
      if (openIds.length === 0) return;
      if (openIds.length > 1) {
        resolutionErrors.push(
          `${anomaly.name}${anomaly.building ? `（${anomaly.building}）` : ''}匹配不唯一`,
        );
        return;
      }
      recipients.set(openIds[0], {
        openId: openIds[0],
        name: anomaly.name,
      });
    });

    return {
      recipients: [...recipients.values()],
      failures: resolutionErrors,
    };
  }

  async sendCard(
    recipientOpenId: string,
    card: AttendanceAnomalyCard,
    idempotencyKey: string,
  ): Promise<string> {
    const openId = recipientOpenId.trim();
    if (!/^ou_[A-Za-z0-9_-]+$/.test(openId)) {
      throw new Error('考勤异常卡片收件人 Open ID 无效');
    }
    if (!idempotencyKey || idempotencyKey.length > 50) {
      throw new Error('考勤异常卡片幂等键必须为 1-50 个字符');
    }
    const token = await getTenantAccessToken(this.httpService);
    const response = await this.httpService.axiosRef.post(
      `${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=open_id`,
      {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
        uuid: idempotencyKey,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30_000,
      },
    );
    assertFeishuSuccess(response.data, '发送考勤异常卡片失败');
    const messageId = String(response.data?.data?.message_id || '').trim();
    if (!messageId)
      throw new Error('发送考勤异常卡片失败：响应缺少 message_id');
    return messageId;
  }

  async sendSyncFailureAlert(alert: AttendanceSyncFailureAlert): Promise<void> {
    const appId = readEnv('FEISHU_APP_ID');
    let openId = CONFIRMED_MANAGER_OPEN_ID;
    if (appId !== CONFIRMED_MANAGER_APP_ID) {
      const managers = await this.listActivePersonnel();
      const openIds = [
        ...new Set(
          managers
            .filter((person) => person.name === '示例人员020')
            .flatMap((person) => person.openIds),
        ),
      ];
      if (openIds.length !== 1) {
        throw new Error('示例人员020在当前飞书应用下的 Open ID 未能唯一确认');
      }
      openId = openIds[0];
    }
    const stageLabel =
      alert.stage === 'archive' ? '飞书考勤多维表归档' : '钉钉补卡及举证同步';
    const text = [
      '【考勤同步故障】',
      `日期：${alert.date}`,
      `任务：${alert.task}`,
      `环节：${stageLabel}`,
      `原因：${alert.detail.slice(0, 500)}`,
      '考勤结果已保留，后台将继续重试。',
    ].join('\n');
    const uuid = createHash('sha256')
      .update(`${alert.date}:${alert.task}:${alert.stage}`)
      .digest('hex')
      .slice(0, 32);
    const token = await getTenantAccessToken(this.httpService);
    const response = await this.httpService.axiosRef.post(
      `${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=open_id`,
      {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        uuid,
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 },
    );
    assertFeishuSuccess(response.data, '考勤同步故障私信发送失败');
    if (!String(response.data?.data?.message_id || '').trim()) {
      throw new Error('考勤同步故障私信发送失败：响应缺少 message_id');
    }
  }

  private async listActivePersonnel(): Promise<PersonnelDirectoryRecord[]> {
    const records = await fetchBitableRecords(this.httpService, {
      appToken:
        readEnv('FEISHU_ATTENDANCE_PERSONNEL_APP_TOKEN') ||
        DEFAULT_PERSONNEL_APP_TOKEN,
      tableId:
        readEnv('FEISHU_ATTENDANCE_PERSONNEL_TABLE_ID') ||
        DEFAULT_PERSONNEL_TABLE_ID,
      tableName: '考勤通知人员组织关系',
      automaticFields: true,
      cacheTtlMs: 30 * 60 * 1000,
      allowStale: true,
      strict: true,
    });
    return records
      .map((record) => mapPersonnelRecord(record.fields || {}))
      .filter((person) => person.openIds.length > 0 && !person.departed);
  }

  private async loadCorrectionEvidence(
    query: TodayAttendanceCorrectionEvidenceQuery,
  ): Promise<CorrectionEvidenceRecord> {
    const cacheKey = [query.businessDate, query.entryKey].join('|');
    const cached = this.correctionEvidenceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.record;
    const appToken =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_APP_TOKEN') ||
      DEFAULT_ATTENDANCE_APP_TOKEN;
    const tableId =
      readEnv('FEISHU_ATTENDANCE_ARCHIVE_TABLE_ID') ||
      DEFAULT_ATTENDANCE_TABLE_ID;
    const records = await fetchBitableRecords(this.httpService, {
      appToken,
      tableId,
      tableName: '钉钉考勤归档',
      automaticFields: true,
      fieldNames: [
        '记录类型',
        '记录唯一键',
        '姓名',
        '钉钉员工ID',
        '工作日期',
        '打卡类型',
        '应打卡时间',
        '补卡状态',
        '补卡审批实例ID',
        '补卡理由',
        '补卡举证材料',
        '原始记录JSON',
        '同步时间',
      ],
      // Legacy approvals without a work date still need verified association.
      filter: {
        conjunction: 'or',
        conditions: [
          {
            field_name: '工作日期',
            operator: 'is',
            value: ['ExactDate', String(Date.parse(`${query.businessDate}T00:00:00+08:00`))],
          },
          { field_name: '记录类型', operator: 'is', value: ['补卡审批'] },
        ],
      },
      cacheTtlMs: 2 * 60 * 1_000,
      forceRefresh: false,
      allowStale: false,
      strict: true,
    });
    const attendanceRecord = records
      .filter((record) => {
        const fields = record.fields || {};
        return (
          extractDisplayText(fields.记录类型).trim() === '考勤结果' &&
          formatShanghaiDateFromValue(fields.工作日期) === query.businessDate
        );
      })
      .sort(
        (left, right) =>
          (timestampFromValue(right.fields?.同步时间) || 0) -
          (timestampFromValue(left.fields?.同步时间) || 0),
      )
      .find((record) => {
        const original = parseArchivedOriginal(record.fields || {});
        return Array.isArray(original.attendanceChecks) && original.attendanceChecks.length > 0
          ? original.attendanceChecks.some(
              (check) => check?.expectation?.key === query.entryKey,
            )
          : original.expectationKey === query.entryKey;
      });
    if (!attendanceRecord) throw new Error('未找到对应的考勤明细');
    const attendanceOriginal = parseArchivedOriginal(
      attendanceRecord.fields || {},
    );
    const checks = Array.isArray(attendanceOriginal.attendanceChecks)
      ? attendanceOriginal.attendanceChecks
      : [];
    const check = checks.find(
      (item) => item?.expectation?.key === query.entryKey,
    );
    const expectation = (check?.expectation ||
      (checks.length === 0 ? parseArchivedExpectation(attendanceRecord.fields || {}, attendanceOriginal) : undefined)) as AttendanceExpectation | undefined;
    let processInstanceId = String(
      check?.processInstanceId ||
        (checks.length <= 1 ? attendanceOriginal.processInstanceId : '') ||
        '',
    ).trim();
    if (!expectation) {
      throw new Error('补卡审批关联待同步，请稍后重试');
    }
    const correctionRecords = records
      .filter(
        (record) =>
          extractDisplayText(record.fields?.记录类型).trim() === '补卡审批',
      )
      .sort(
        (left, right) =>
          (timestampFromValue(right.fields?.同步时间) || 0) -
          (timestampFromValue(left.fields?.同步时间) || 0),
      );
    let correctionRecord = processInstanceId
      ? correctionRecords.find(
          (record) =>
            extractDisplayText(record.fields?.补卡审批实例ID).trim() ===
            processInstanceId,
        )
      : undefined;
    if (!processInstanceId) {
      const expectedDirection = checkTypeLabel(expectation.direction);
      const employeeId = extractDisplayText(attendanceRecord.fields?.钉钉员工ID).trim();
      const expectedTimestamp = Date.parse(`${expectation.expectedAt.replace(' ', 'T')}+08:00`);
      const candidatesByProcess = new Map<string, BitableRecordItem>();
      correctionRecords.forEach((record) => {
        const fields = record.fields || {};
        const candidateProcessId = extractDisplayText(
          fields.补卡审批实例ID,
        ).trim();
        const candidateEmployeeId = extractDisplayText(fields.钉钉员工ID).trim();
        const identityMatches = employeeId && candidateEmployeeId
          ? employeeId === candidateEmployeeId
          : normalizeName(extractDisplayText(fields.姓名)) === normalizeName(expectation.name);
        const dateMatches = formatShanghaiDateFromValue(fields.工作日期) === query.businessDate ||
          (employeeId && employeeId === candidateEmployeeId &&
            timestampFromValue(fields.应打卡时间) === expectedTimestamp);
        if (
          candidateProcessId &&
          identityMatches && dateMatches &&
          extractDisplayText(fields.打卡类型).trim() === expectedDirection &&
          extractDisplayText(fields.补卡状态).trim() === '已通过' &&
          !candidatesByProcess.has(candidateProcessId)
        ) {
          candidatesByProcess.set(candidateProcessId, record);
        }
      });
      const legacyCandidates = [...candidatesByProcess.entries()];
      if (legacyCandidates.length > 1) {
        throw new Error('补卡审批关联不唯一，无法确认举证图片');
      }
      if (legacyCandidates.length === 1) {
        [processInstanceId, correctionRecord] = legacyCandidates[0];
      }
    }
    if (!processInstanceId) {
      throw new Error('补卡审批关联待同步，请稍后重试');
    }
    if (!correctionRecord) throw new Error('补卡举证尚未同步');
    const recordId = getRecordId(correctionRecord);
    if (!recordId) throw new Error('补卡举证记录缺少记录 ID');
    const latestFields = correctionRecord.fields || {};
    const fileTokens = extractAttachmentTokens(latestFields.补卡举证材料);
    const result: CorrectionEvidenceRecord = {
      businessDate: query.businessDate,
      entryKey: query.entryKey,
      name: expectation.name,
      direction: expectation.direction,
      status: extractDisplayText(latestFields.补卡状态).trim(),
      reason: extractDisplayText(latestFields.补卡理由).trim(),
      imageCount: fileTokens.length,
      appToken,
      tableId,
      recordId,
      processInstanceId,
      fileTokens,
    };
    this.correctionEvidenceCache.set(cacheKey, {
      expiresAt: Date.now() + 30_000,
      record: result,
    });
    return result;
  }

  private async postBitableBatch(
    url: string,
    body: Record<string, unknown>,
    token: string,
  ): Promise<void> {
    const response = await this.httpService.axiosRef.post(url, body, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30_000,
    });
    assertFeishuSuccess(response.data, '写入飞书考勤归档失败');
  }

  private async buildCorrectionRows(input: {
    input: ArchiveInput;
    corrections: readonly DingTalkCorrectionApproval[];
    appToken: string;
    token: string;
    existingByKey: ReadonlyMap<string, BitableRecordItem>;
  }): Promise<ArchiveRow[]> {
    const namesByUserId = new Map(
      input.input.users.map((user) => [user.userId, user.name]),
    );
    const rows: ArchiveRow[] = [];
    for (const correction of input.corrections) {
      const key = `ding-correction-${correction.processInstanceId}`;
      const existingEvidence = extractAttachmentTokens(
        input.existingByKey.get(key)?.fields?.['补卡举证材料'],
      );
      if (existingEvidence.length === correction.photoUrls.length) {
        await this.ensureCorrectionEvidenceInCos(correction);
      }
      const evidence =
        existingEvidence.length === correction.photoUrls.length
          ? existingEvidence.map((fileToken) => ({ file_token: fileToken }))
          : await this.uploadCorrectionEvidence(
              correction,
              input.appToken,
              input.token,
            );
      const name = namesByUserId.get(correction.userId) || '';
      const relatedResult = closestCorrectionResult(
        input.input.results,
        correction,
      );
      const checkType =
        relatedResult?.checkType ||
        inferCorrectionCheckType(correction.planText);
      rows.push({
        key,
        expectedEvidenceCount: correction.photoUrls.length,
        fields: compactFields({
          文本: `${formatShanghaiDate(correction.correctionTime || correction.workDate)} ${name} 补卡审批`.trim(),
          记录唯一键: key,
          记录类型: '补卡审批',
          钉钉员工ID: correction.userId,
          姓名: name,
          工作日期:
            correction.workDate || correction.correctionTime || undefined,
          打卡类型: checkTypeLabel(checkType),
          应打卡时间: correction.correctionTime || undefined,
          数据来源: '审批',
          补卡状态: correctionStatusLabel(correction),
          补卡审批实例ID: correction.processInstanceId,
          补卡理由: correction.reason,
          补卡举证材料: evidence.length > 0 ? evidence : undefined,
          补卡异常说明:
            correction.photoUrls.length === 0 ? '未提供举证照片' : undefined,
          原始记录JSON: safeJson(correction.original),
          同步时间: Date.now(),
          同步状态: '成功',
        }),
      });
    }
    return rows;
  }

  private async uploadCorrectionEvidence(
    correction: DingTalkCorrectionApproval,
    appToken: string,
    token: string,
  ): Promise<Array<{ file_token: string }>> {
    const files: Array<{ file_token: string }> = [];
    for (let index = 0; index < correction.photoUrls.length; index += 1) {
      const photoUrl = correction.photoUrls[index];
      const parsed = new URL(photoUrl);
      if (
        parsed.protocol !== 'https:' ||
        !(
          parsed.hostname === 'static.dingtalk.com' ||
          parsed.hostname.endsWith('.static.dingtalk.com')
        )
      ) {
        throw new Error('钉钉补卡举证照片地址不在允许域名内');
      }
      const download = await this.httpService.axiosRef.get(photoUrl, {
        responseType: 'arraybuffer',
        timeout: 30_000,
        maxContentLength: MAX_CORRECTION_IMAGE_BYTES,
      });
      const buffer = Buffer.from(download.data);
      const mimeType = String(download.headers?.['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!mimeType.startsWith('image/') || buffer.length === 0) {
        throw new Error('钉钉补卡举证附件不是有效图片');
      }
      if (buffer.length > MAX_CORRECTION_IMAGE_BYTES) {
        throw new Error('钉钉补卡举证图片超过 10MB');
      }
      await this.requireCorrectionEvidenceStorage().ensureStored(
        { processInstanceId: correction.processInstanceId, index },
        async () => ({ buffer, contentType: mimeType }),
      );
      const fileName = correctionEvidenceFileName(correction, index, mimeType);
      const form = new FormData();
      form.append('file_name', fileName);
      form.append('parent_type', 'bitable_file');
      form.append('parent_node', appToken);
      form.append('size', String(buffer.length));
      form.append('file', buffer, {
        filename: fileName,
        contentType: mimeType,
      });
      const response = await this.httpService.axiosRef.post(
        `${FEISHU_BASE_URL}/drive/v1/medias/upload_all`,
        form,
        {
          headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
          maxBodyLength: Infinity,
          timeout: 30_000,
        },
      );
      assertFeishuSuccess(response.data, '上传补卡举证材料失败');
      const fileToken = String(response.data?.data?.file_token || '').trim();
      if (!fileToken) {
        throw new Error('上传补卡举证材料失败：响应缺少 file_token');
      }
      files.push({ file_token: fileToken });
    }
    return files;
  }

  private async ensureCorrectionEvidenceInCos(
    correction: DingTalkCorrectionApproval,
  ): Promise<void> {
    const storage = this.requireCorrectionEvidenceStorage();
    await Promise.all(
      correction.photoUrls.map((photoUrl, index) =>
        storage.ensureStored(
          { processInstanceId: correction.processInstanceId, index },
          () => this.downloadDingTalkCorrectionEvidence(photoUrl),
        ),
      ),
    );
  }

  private async downloadDingTalkCorrectionEvidence(
    photoUrl: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const parsed = new URL(photoUrl);
    if (
      parsed.protocol !== 'https:' ||
      !(
        parsed.hostname === 'static.dingtalk.com' ||
        parsed.hostname.endsWith('.static.dingtalk.com')
      )
    ) {
      throw new Error('钉钉补卡举证照片地址不在允许域名内');
    }
    const response = await this.httpService.axiosRef.get(photoUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: MAX_CORRECTION_IMAGE_BYTES,
    });
    const buffer = Buffer.from(response.data || []);
    const contentType = normalizeCorrectionImageContentType(
      String(response.headers?.['content-type'] || ''),
    );
    if (
      !String(response.headers?.['content-type'] || '').startsWith('image/')
    ) {
      throw new Error('钉钉补卡举证附件不是有效图片');
    }
    if (!buffer.length || buffer.length > MAX_CORRECTION_IMAGE_BYTES) {
      throw new Error('钉钉补卡举证图片为空或超过 10MB');
    }
    return { buffer, contentType };
  }

  private async downloadFeishuCorrectionEvidence(
    evidence: Pick<
      CorrectionEvidenceRecord,
      'appToken' | 'recordId' | 'tableId'
    >,
    fileToken: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const token = await getTenantAccessToken(this.httpService);
    const fieldId = await this.resolveCorrectionEvidenceFieldId(
      evidence.appToken,
      evidence.tableId,
      token,
    );
    const response = await this.httpService.axiosRef.get(
      `${FEISHU_BASE_URL}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          extra: JSON.stringify({
            bitablePerm: {
              tableId: evidence.tableId,
              attachments: {
                [fieldId]: { [evidence.recordId]: [fileToken] },
              },
            },
          }),
        },
        responseType: 'arraybuffer',
        timeout: 30_000,
        maxContentLength: MAX_CORRECTION_IMAGE_BYTES,
      },
    );
    const buffer = Buffer.from(response.data || []);
    if (!buffer.length || buffer.length > MAX_CORRECTION_IMAGE_BYTES) {
      throw new Error('补卡举证图片为空或超过 10MB');
    }
    return {
      buffer,
      contentType: normalizeCorrectionImageContentType(
        String(response.headers?.['content-type'] || ''),
      ),
    };
  }

  private async resolveCorrectionEvidenceFieldId(
    appToken: string,
    tableId: string,
    token: string,
  ): Promise<string> {
    const cacheKey = `${appToken}:${tableId}`;
    const cached = this.correctionEvidenceFieldIdCache.get(cacheKey);
    if (cached) return cached;

    let pageToken = '';
    do {
      const response = await this.httpService.axiosRef.get(
        `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            page_size: 200,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
          timeout: 30_000,
        },
      );
      assertFeishuSuccess(response.data, '读取补卡举证字段失败');
      const items = Array.isArray(response.data?.data?.items)
        ? response.data.data.items
        : [];
      const field = items.find(
        (item: { field_id?: unknown; field_name?: unknown }) =>
          String(item.field_name || '').trim() === '补卡举证材料' &&
          String(item.field_id || '').trim(),
      );
      if (field) {
        const fieldId = String(field.field_id).trim();
        this.correctionEvidenceFieldIdCache.set(cacheKey, fieldId);
        return fieldId;
      }
      pageToken = response.data?.data?.has_more
        ? String(response.data?.data?.page_token || '').trim()
        : '';
    } while (pageToken);

    throw new Error('未找到补卡举证材料字段');
  }

  private requireCorrectionEvidenceStorage(): AttendanceCorrectionEvidenceStorageService {
    if (!this.correctionEvidenceStorage) {
      throw new Error('补卡举证对象存储未配置');
    }
    return this.correctionEvidenceStorage;
  }
}

function normalizeCorrectionImageContentType(value: string): string {
  const normalized = value.split(';')[0].trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return /^image\/(png|jpeg|webp|gif)$/u.test(normalized)
    ? normalized
    : 'image/jpeg';
}

function correctionEvidencePublicFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.includes('未配置')) return '补卡举证存储未配置';
  if (message.includes('写入失败')) return '补卡举证保存失败';
  if (message.includes('读取失败')) return '补卡举证存储暂不可用';
  if (message.includes('访问地址失败')) return '补卡举证访问地址生成失败';
  if (message.includes('为空')) return '补卡举证图片为空';
  return '补卡举证后台迁移失败';
}

function buildArchiveRows(input: ArchiveInput): ArchiveRow[] {
  const namesByUserId = new Map(
    input.users.map((user) => [user.userId, user.name]),
  );
  const syncTime = Date.now();
  const resultRows = input.results.map((record) => {
    const key = buildArchiveKey('result', record);
    const expectationKey = derivedExpectationKey(record);
    const attendanceShiftKey =
      attendanceShiftKeyFromExpectationKey(expectationKey);
    const name = namesByUserId.get(record.userId) || '';
    const correctionIssue = correctionEvidenceAnomalyReason(record);
    return {
      key,
      ...(expectationKey ? { expectationKey } : {}),
      fields: compactFields({
        文本: `${input.businessDate} ${name} ${checkTypeLabel(record.checkType)} ${timeResultLabel(record.timeResult)}`.trim(),
        记录唯一键: key,
        记录类型: '考勤结果',
        钉钉记录ID: record.id === null ? '' : String(record.id),
        钉钉员工ID: record.userId,
        姓名: name,
        工作日期:
          toTimestamp(record.workDate) || toTimestamp(input.businessDate),
        打卡类型: checkTypeLabel(record.checkType),
        应打卡时间: toTimestamp(record.baseCheckTime),
        实际打卡时间: toTimestamp(record.userCheckTime),
        时间状态: timeResultLabel(record.timeResult),
        位置状态: locationResultLabel(record.locationResult),
        是否合法:
          record.timeResult === 'NotSigned' || correctionIssue ? '否' : '是',
        数据来源: sourceTypeLabel(record.sourceType),
        补卡异常说明: correctionIssue,
        原始记录JSON: safeJson({
          ...record.original,
          ...(attendanceShiftKey ? { attendanceShiftKey } : {}),
        }),
        同步时间: syncTime,
        同步状态: '成功',
      }),
    };
  });
  const detailRows = input.details.map((record) => {
    const key = buildArchiveKey('detail', record);
    const name = namesByUserId.get(record.userId) || '';
    const detailCheckType = resolveDetailCheckType(record);
    const attendanceShiftKey = resolveDetailAttendanceShiftKey(
      record,
      input.results,
      input.businessDate,
    );
    return {
      key,
      fields: compactFields({
        文本: `${input.businessDate} ${name} ${checkTypeLabel(detailCheckType)} 打卡明细`.trim(),
        记录唯一键: key,
        记录类型: '打卡明细',
        钉钉记录ID: record.id === null ? '' : String(record.id),
        钉钉员工ID: record.userId,
        姓名: name,
        工作日期:
          toTimestamp(record.workDate) || toTimestamp(input.businessDate),
        打卡类型: checkTypeLabel(detailCheckType),
        应打卡时间: toTimestamp(record.baseCheckTime),
        实际打卡时间: toTimestamp(record.userCheckTime),
        时间状态: timeResultLabel(record.timeResult),
        位置状态: locationResultLabel(record.locationResult),
        是否合法: record.invalidRecordMsg ? '否' : '是',
        数据来源: sourceTypeLabel(record.sourceType),
        打卡地址: record.userAddress,
        经度: record.userLongitude,
        纬度: record.userLatitude,
        外勤备注: record.outsideRemark,
        无效原因: record.invalidRecordMsg,
        设备ID: record.deviceId,
        原始记录JSON: safeJson({
          ...record.original,
          ...(attendanceShiftKey ? { attendanceShiftKey } : {}),
          rawPunches: [
            {
              recordId: record.id === null ? '' : String(record.id),
              direction: detailCheckType,
              userCheckTime: record.userCheckTime,
              invalidReason: record.invalidRecordMsg,
              sourceType: record.sourceType,
            },
          ],
        }),
        同步时间: syncTime,
        同步状态: '成功',
      }),
    };
  });
  return [
    ...new Map(
      [...resultRows, ...detailRows].map((row) => [row.key, row]),
    ).values(),
  ];
}

function resolveDetailAttendanceShiftKey(
  detail: DingTalkAttendanceRawDetail,
  results: readonly DingTalkAttendanceRawResult[],
  businessDate: string,
): string {
  const detailTime = toTimestamp(detail.baseCheckTime ?? detail.userCheckTime);
  const detailCheckType = resolveDetailCheckType(detail);
  const candidates = results
    .flatMap((result) => {
      if (
        result.userId !== detail.userId ||
        result.checkType !== detailCheckType
      ) {
        return [];
      }
      const expectationKey = derivedExpectationKey(result);
      const shiftKey = attendanceShiftKeyFromExpectationKey(expectationKey);
      if (!shiftKey) return [];
      const resultTime = toTimestamp(result.baseCheckTime);
      return [
        {
          distance:
            detailTime && resultTime
              ? Math.abs(detailTime - resultTime)
              : Number.POSITIVE_INFINITY,
          shiftKey,
        },
      ];
    })
    .sort((left, right) => left.distance - right.distance);
  if (candidates.length && candidates[0].distance <= 3 * 60 * 60 * 1_000) {
    const closest = candidates.filter(
      (candidate) => candidate.distance === candidates[0].distance,
    );
    if (new Set(closest.map((candidate) => candidate.shiftKey)).size === 1) {
      return closest[0].shiftKey;
    }
  }
  const userDateShiftKeys = new Set(
    results.flatMap((result) => {
      if (result.userId !== detail.userId) return [];
      const shiftKey = attendanceShiftKeyFromExpectationKey(
        derivedExpectationKey(result),
      );
      return shiftKey?.startsWith(`${businessDate}:`) ? [shiftKey] : [];
    }),
  );
  return userDateShiftKeys.size === 1 ? [...userDateShiftKeys][0] : '';
}

function resolveDetailCheckType(
  detail: DingTalkAttendanceRawDetail,
): DingTalkAttendanceRawDetail['checkType'] {
  if (detail.checkType === 'OnDuty' || detail.checkType === 'OffDuty') {
    return detail.checkType;
  }
  const reason = String(detail.invalidRecordMsg || '');
  if (/上班时间以最早打卡时间为准/u.test(reason)) return 'OnDuty';
  if (/下班时间以最晚打卡时间为准/u.test(reason)) return 'OffDuty';
  return detail.checkType;
}

function attendanceShiftKeyFromExpectationKey(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2}):(building_[abcdeh]|station_110):(white|night|long_white):(OnDuty|OffDuty):.+$/u.exec(
      value,
    );
  return match ? [match[1], match[2], match[3]].join(':') : '';
}

function buildArchivedAttendanceSummary(
  businessDate: string,
  records: readonly BitableRecordItem[],
): ArchivedAttendanceSummary {
  const anomalies: AttendanceAnomaly[] = [];
  const normal: AttendanceExpectation[] = [];
  const normalByBuilding: Record<string, number> = {};
  let latestSyncTime = 0;
  let hasArchivedResult = false;
  const checkedTasks = new Set<
    Exclude<AttendanceAutomationTask, 'archive-yesterday'>
  >();

  buildLatestArchivedResultRecords(records)
    .filter((item) => item.businessDate === businessDate)
    .forEach((item) => {
      latestSyncTime = Math.max(latestSyncTime, item.syncTime);
      hasArchivedResult ||= item.archived;
      if (item.task) checkedTasks.add(item.task);
      if (item.reason) {
        anomalies.push({ ...item.expectation, reason: item.reason });
        return;
      }
      normal.push(item.expectation);
      normalByBuilding[item.expectation.building] =
        (normalByBuilding[item.expectation.building] || 0) + 1;
    });

  return {
    businessDate,
    fetchedAt: formatShanghaiMinuteFromEpoch(latestSyncTime || Date.now()),
    hasArchivedResult,
    anomalies,
    normal,
    normalByBuilding,
    checkedTasks: [...checkedTasks],
  };
}

function buildArchivedAttendancePeriodSummary(
  startDate: string,
  endDate: string,
  records: readonly BitableRecordItem[],
): ArchivedAttendancePeriodSummary {
  const current = buildLatestArchivedResultRecords(records).filter(
    (item) => item.businessDate >= startDate && item.businessDate <= endDate,
  );
  const anomalies: ArchivedAttendancePeriodSummary['anomalies'] = [];
  const normal: AttendanceExpectation[] = [];
  const corrected: ArchivedAttendancePeriodSummary['corrected'] = [];
  let latestSyncTime = 0;
  current.forEach((item) => {
    latestSyncTime = Math.max(latestSyncTime, item.syncTime);
    if (item.reason)
      anomalies.push({
        ...item.expectation,
        businessDate: item.businessDate,
        reason: item.reason,
      });
    else if (item.corrected)
      corrected.push({ ...item.expectation, businessDate: item.businessDate });
    else normal.push(item.expectation);
  });
  return {
    startDate,
    endDate,
    fetchedAt: formatShanghaiMinuteFromEpoch(latestSyncTime || Date.now()),
    checkedCount: current.length,
    anomalies,
    normal,
    corrected,
  };
}

export function findApprovedLeaveMissingPunchRecordIds(
  records: readonly BitableRecordItem[],
  businessDates: readonly string[],
  approvedLeave: readonly ApprovedLeaveRequest[],
): string[] {
  const dates = new Set(businessDates);
  return records.flatMap((record) => {
    const fields = record.fields || {};
    const recordId = getRecordId(record);
    const punchCount = Number(fields.打卡次数 ?? 0);
    if (
      !recordId ||
      extractDisplayText(fields.记录类型).trim() !== '考勤结果' ||
      !dates.has(formatShanghaiDateFromValue(fields.工作日期)) ||
      extractDisplayText(fields.时间状态).trim() !== '未打卡' ||
      fields.实际打卡时间 ||
      !Number.isFinite(punchCount) ||
      punchCount !== 0 ||
      extractDisplayText(fields.全部打卡时间).trim() ||
      extractAttachmentTokens(fields.补卡举证材料).length > 0
    ) return [];
    const original = parseArchivedOriginal(fields);
    if (Array.isArray(original.rawPunches) && original.rawPunches.length > 0)
      return [];
    const checks = Array.isArray(original.attendanceChecks)
      ? original.attendanceChecks
      : [];
    const expectations = checks.length
      ? checks.map((check) => check?.expectation as AttendanceExpectation | undefined)
      : [parseArchivedExpectation(fields, original)];
    if (
      expectations.length === 0 ||
      expectations.some(
        (event) =>
          !event ||
          !event.name ||
          !event.building ||
          !event.expectedAt ||
          !['OnDuty', 'OffDuty'].includes(event.direction),
      )
    ) return [];
    return expectations.every((event) =>
      excludesApprovedLeave(event!, approvedLeave),
    )
      ? [recordId]
      : [];
  });
}

interface LatestArchivedResultRecord {
  businessDate: string;
  userId: string;
  expectation: AttendanceExpectation;
  reason: AttendanceAnomaly['reason'] | null;
  syncTime: number;
  archived: boolean;
  corrected: boolean;
  task?: Exclude<AttendanceAutomationTask, 'archive-yesterday'>;
}

function buildLatestArchivedResultRecords(
  records: readonly BitableRecordItem[],
): LatestArchivedResultRecord[] {
  const latest = new Map<string, LatestArchivedResultRecord>();
  records.forEach((record) => {
    const fields = record.fields || {};
    if (
      extractDisplayText(pickField(fields, ['记录类型'])).trim() !== '考勤结果'
    ) {
      return;
    }
    const original = parseArchivedOriginal(fields);
    if (
      Array.isArray(original.attendanceChecks) &&
      original.attendanceChecks.length
    ) {
      const businessDate = formatShanghaiDateFromValue(fields.工作日期);
      const syncTime = timestampFromValue(fields.同步时间) || 0;
      for (const check of original.attendanceChecks) {
        const event = check?.expectation as AttendanceExpectation | undefined;
        if (
          !event ||
          typeof event.key !== 'string' ||
          typeof event.name !== 'string' ||
          typeof event.building !== 'string' ||
          typeof event.shiftLabel !== 'string' ||
          ![
            'on_duty',
            'substitute',
            'vacancy_substitute',
            'overtime',
            'leave',
            'time_off',
            'travel',
          ].includes(event.status) ||
          !['OnDuty', 'OffDuty'].includes(event.direction) ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(event.expectedAt) ||
          !businessDate
        ) {
          throw new Error('考勤归档核验明细无效，暂停汇总');
        }
        const classified = classifyAttendanceExpectations(
          [event],
          [{ ...check, expectationKey: event.key }],
        );
        const item: LatestArchivedResultRecord = {
          businessDate,
          userId: extractDisplayText(fields.钉钉员工ID).trim(),
          expectation: event,
          reason: classified.anomalies[0]?.reason || null,
          syncTime,
          archived: original.automationTask === 'archive-yesterday',
          corrected: isApprovedCorrectionCheck(check),
          task: archivedAutomationTask(original.automationTask),
        };
        const previous = latest.get(event.key);
        if (!previous || item.syncTime >= previous.syncTime)
          latest.set(event.key, item);
      }
      return;
    }
    const expectation = parseArchivedExpectation(fields, original);
    const businessDate = formatShanghaiDateFromValue(
      pickField(fields, ['工作日期']),
    );
    if (!expectation || !businessDate) return;
    const syncTime = timestampFromValue(pickField(fields, ['同步时间'])) || 0;
    const timeStatus = extractDisplayText(
      pickField(fields, ['时间状态']),
    ).trim();
    const legality = extractDisplayText(pickField(fields, ['是否合法'])).trim();
    const correctionIssue = extractDisplayText(
      pickField(fields, ['补卡异常说明']),
    ).trim();
    const task = archivedAutomationTask(original.automationTask);
    const item: LatestArchivedResultRecord = {
      businessDate,
      userId: extractDisplayText(pickField(fields, ['钉钉员工ID'])).trim(),
      expectation,
      reason: archivedAnomalyReason(timeStatus, legality, correctionIssue),
      syncTime,
      archived: original.automationTask === 'archive-yesterday',
      corrected: isApprovedCorrectionCheck(original),
      ...(task ? { task } : {}),
    };
    const current = latest.get(expectation.key);
    if (!current || item.syncTime >= current.syncTime) {
      latest.set(expectation.key, item);
    }
  });
  return [...latest.values()];
}

function parseArchivedExpectation(
  fields: Record<string, unknown>,
  original = parseArchivedOriginal(fields),
): Omit<AttendanceAnomaly, 'reason'> | null {
  const expectationKey = String(original.expectationKey || '').trim();
  const match =
    /^(\d{4}-\d{2}-\d{2}):(building_[abcdeh]|station_110):(white|night|long_white):(OnDuty|OffDuty):(.+)$/u.exec(
      expectationKey,
    );
  if (!match) return null;
  const [, date, buildingCode, shift, rawDirection, keyName] = match;
  const direction = rawDirection as AttendanceAnomaly['direction'];
  const name =
    extractDisplayText(pickField(fields, ['姓名'])).trim() || keyName.trim();
  const expectedTimestamp = timestampFromValue(
    pickField(fields, ['应打卡时间']),
  );
  if (!name || !expectedTimestamp) return null;
  return {
    key: expectationKey,
    name,
    building: archivedBuildingLabel(buildingCode),
    shiftLabel:
      shift === 'night' ? '夜班' : shift === 'long_white' ? '长白班' : '白班',
    direction,
    expectedAt: formatShanghaiSecondFromEpoch(expectedTimestamp),
    status: 'on_duty',
  };
}

function parseArchivedOriginal(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const raw = extractRawText(pickField(fields, ['原始记录JSON']));
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function archivedAutomationTask(
  value: unknown,
): Exclude<AttendanceAutomationTask, 'archive-yesterday'> | undefined {
  const task = String(value || '').trim();
  return task === 'morning-on-duty-reminder' ||
    task === 'morning-off-duty-check' ||
    task === 'evening-on-duty-reminder' ||
    task === 'evening-off-duty-check'
    ? task
    : undefined;
}

function extractRawText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(extractRawText).join('').trim();
  }
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const object = value as Record<string, unknown>;
  for (const key of ['text', 'value']) {
    const extracted = extractRawText(object[key]);
    if (extracted) return extracted;
  }
  return '';
}

function archivedAnomalyReason(
  timeStatus: string,
  legality: string,
  correctionIssue = '',
): AttendanceAnomaly['reason'] | null {
  if (correctionIssue === '补卡审批未通过') return '补卡审批未通过';
  if (
    correctionIssue === '补卡未提供举证照片' ||
    correctionIssue === '补卡举证未核验'
  ) {
    return null;
  }
  if (['未打卡', '迟到', '严重迟到', '早退', '旷工'].includes(timeStatus)) {
    return timeStatus === '严重迟到'
      ? '迟到'
      : (timeStatus as AttendanceAnomaly['reason']);
  }
  if (legality === '否') return '考勤结果异常';
  return null;
}

function correctionEvidenceAnomalyReason(
  record: DingTalkAttendanceRawResult,
): AttendanceAnomaly['reason'] | undefined {
  if (!/APPROVE/iu.test(record.sourceType || '')) return undefined;
  if (
    record.correctionEvidenceStatus === 'pending' ||
    record.correctionEvidenceStatus === 'rejected'
  ) {
    return '补卡审批未通过';
  }
  return undefined;
}

function isApprovedCorrectionCheck(value: Record<string, any>): boolean {
  if (!/APPROVE/iu.test(String(value.sourceType || ''))) return false;
  return !['pending', 'rejected'].includes(
    String(value.correctionEvidenceStatus || '').toLowerCase(),
  );
}

function archivedBuildingLabel(buildingCode: string): string {
  if (buildingCode === 'station_110') return '110站';
  const match = /^building_([abcdeh])$/u.exec(buildingCode);
  return match ? `${match[1].toUpperCase()}楼` : buildingCode;
}

function timestampFromValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = extractDisplayText(value).trim();
  if (!text) return null;
  if (/^\d+$/u.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = toTimestamp(text);
  return parsed && Number.isFinite(parsed) ? parsed : null;
}

function formatShanghaiDateFromValue(value: unknown): string {
  const timestamp = timestampFromValue(value);
  return timestamp ? formatShanghaiSecondFromEpoch(timestamp).slice(0, 10) : '';
}

function formatShanghaiSecondFromEpoch(timestamp: number): string {
  return new Date(timestamp + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function formatShanghaiMinuteFromEpoch(timestamp: number): string {
  return formatShanghaiSecondFromEpoch(timestamp).slice(0, 16);
}

function assertDateKey(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`考勤归档业务日期无效：${value}`);
  }
}

function buildArchiveKey(
  type: 'result' | 'detail',
  record: DingTalkAttendanceRawResult | DingTalkAttendanceRawDetail,
): string {
  const expectationKey =
    type === 'result'
      ? derivedExpectationKey(record as DingTalkAttendanceRawResult)
      : '';
  const stable = [
    type,
    ...(expectationKey
      ? [expectationKey]
      : [
          record.id ?? '',
          record.userId,
          record.checkType ?? '',
          record.baseCheckTime ?? '',
          record.userCheckTime ?? '',
        ]),
  ].join('|');
  return `ding-${type === 'result' ? 'r' : 'd'}-${createHash('sha256')
    .update(stable)
    .digest('hex')
    .slice(0, 32)}`;
}

function derivedExpectationKey(record: DingTalkAttendanceRawResult): string {
  if (record.original?.derived !== true) return '';
  return String(record.original.expectationKey || '').trim();
}

function buildLatestExistingByExpectationKey(
  records: readonly BitableRecordItem[],
): Map<string, BitableRecordItem> {
  const result = new Map<
    string,
    { record: BitableRecordItem; syncTime: number }
  >();
  records.forEach((record) => {
    const fields = record.fields || {};
    if (
      extractDisplayText(pickField(fields, ['记录类型'])).trim() !== '考勤结果'
    ) {
      return;
    }
    const expectation = parseArchivedExpectation(fields);
    if (!expectation || !getRecordId(record)) return;
    const syncTime = timestampFromValue(pickField(fields, ['同步时间'])) || 0;
    const current = result.get(expectation.key);
    if (!current || syncTime >= current.syncTime) {
      result.set(expectation.key, { record, syncTime });
    }
  });
  return new Map(
    [...result.entries()].map(([key, value]) => [key, value.record]),
  );
}

function mapPersonnelRecord(
  fields: Record<string, unknown>,
): PersonnelDirectoryRecord {
  const name =
    extractDisplayText(pickField(fields, ['姓名'])).trim() ||
    extractDisplayText(pickField(fields, ['员工姓名'])).trim();
  const openIds = extractOpenIds(pickField(fields, ['员工姓名']));
  const position = extractDisplayText(
    pickField(fields, ['岗位', '体系岗位']),
    ' ',
  ).trim();
  const building = normalizeBuilding(
    extractDisplayText(pickField(fields, ['机楼/专业', '楼栋']), ' '),
  );
  const departed = isTruthyField(
    pickField(fields, ['离职/异动情况', '是否离职']),
  );
  return { name, openIds, position, building, departed };
}

function normalizeName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '');
}

function extractOpenIds(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== 'object') return;
    const object = item as Record<string, unknown>;
    const id = String(
      object.open_id || object.openId || object.id || '',
    ).trim();
    if (/^ou_[A-Za-z0-9_-]+$/.test(id)) ids.push(id);
    Object.values(object).forEach((child) => {
      if (child !== item && typeof child === 'object') visit(child);
    });
  };
  visit(value);
  return [...new Set(ids)];
}

function normalizeBuilding(value: string): string {
  const text = String(value || '').toUpperCase();
  const match = text.match(/(?:^|\s)(110|[ABCDEH])(?:楼|栋|站|\s|$)/i);
  if (!match) return '';
  return match[1] === '110' ? '110站' : `${match[1]}楼`;
}

function isTruthyField(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return extractDisplayValues(value).some((item) =>
    /^(true|1|是|已离职|异动)$/i.test(item.trim()),
  );
}

function checkTypeLabel(value: string | null): string | undefined {
  if (value === 'OnDuty') return '上班';
  if (value === 'OffDuty') return '下班';
  return undefined;
}

function timeResultLabel(value: string | null): string | undefined {
  const labels: Record<string, string> = {
    Normal: '正常',
    Late: '迟到',
    SeriousLate: '严重迟到',
    Early: '早退',
    EarlyLeave: '早退',
    Absenteeism: '旷工',
    NotSigned: '未打卡',
  };
  return value ? labels[value] : undefined;
}

function locationResultLabel(value: string | null): string | undefined {
  if (!value) return undefined;
  if (/^(Normal|Inside)$/i.test(value)) return '范围内';
  if (/^(Outside|NotSigned)$/i.test(value)) {
    return value === 'NotSigned' ? '未打卡' : '范围外';
  }
  return undefined;
}

function sourceTypeLabel(value: string | null): string {
  if (/ATM|MACHINE/i.test(value || '')) return '钉钉考勤机';
  if (/BEACON|BLUETOOTH/i.test(value || '')) return '蓝牙打卡';
  if (/APPROVE/i.test(value || '')) return '审批';
  if (/SYSTEM/i.test(value || '')) return '系统';
  return '员工打卡';
}

function toTimestamp(value: number | string | null): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = Date.parse(hasZone ? normalized : `${normalized}+08:00`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    ),
  );
}

function safeJson(value: Record<string, unknown>): string {
  return JSON.stringify(value).slice(0, 90_000);
}

function closestCorrectionResult(
  results: readonly DingTalkAttendanceRawResult[],
  correction: DingTalkCorrectionApproval,
): DingTalkAttendanceRawResult | undefined {
  if (correction.correctionTime === null) return undefined;
  return results
    .filter(
      (record) =>
        record.userId === correction.userId &&
        /APPROVE/iu.test(record.sourceType || '') &&
        Math.abs(
          (toTimestamp(record.baseCheckTime) || Number.NaN) -
            correction.correctionTime!,
        ) <=
          90 * 60 * 1000,
    )
    .sort(
      (left, right) =>
        Math.abs(
          (toTimestamp(left.baseCheckTime) || 0) - correction.correctionTime!,
        ) -
        Math.abs(
          (toTimestamp(right.baseCheckTime) || 0) - correction.correctionTime!,
        ),
    )[0];
}

function inferCorrectionCheckType(planText: string): string | null {
  if (planText.includes('上班')) return 'OnDuty';
  if (planText.includes('下班')) return 'OffDuty';
  return null;
}

function correctionStatusLabel(correction: DingTalkCorrectionApproval): string {
  if (/^(RUNNING|NEW)$/iu.test(correction.status)) return '审批中';
  if (/^(agree|approved|pass)$/iu.test(correction.result)) return '已通过';
  if (/^(refuse|rejected|deny)$/iu.test(correction.result)) return '已拒绝';
  if (/^(TERMINATED|CANCELED)$/iu.test(correction.status)) return '已撤销';
  return '未知';
}

function formatShanghaiDate(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '';
  return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function correctionEvidenceFileName(
  correction: DingTalkCorrectionApproval,
  index: number,
  mimeType: string,
): string {
  const extension =
    mimeType === 'image/png'
      ? 'png'
      : mimeType === 'image/webp'
        ? 'webp'
        : mimeType === 'image/gif'
          ? 'gif'
          : 'jpg';
  const digest = createHash('sha256')
    .update(`${correction.processInstanceId}:${index}`)
    .digest('hex')
    .slice(0, 16);
  return `attendance-correction-${digest}.${extension}`;
}

function extractAttachmentTokens(value: unknown): string[] {
  const tokens: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const token = String(record.file_token || record.fileToken || '').trim();
    if (token) tokens.push(token);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...new Set(tokens)];
}

function recordsUrl(appToken: string, tableId: string): string {
  return `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
}

function assertFeishuSuccess(value: unknown, stage: string): void {
  const data =
    value && typeof value === 'object' ? (value as Record<string, any>) : {};
  if (Number(data.code || 0) !== 0) {
    throw new Error(`${stage}：${String(data.msg || data.code || '未知错误')}`);
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
