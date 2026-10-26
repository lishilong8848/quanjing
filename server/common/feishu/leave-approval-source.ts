import type { HttpService } from '@nestjs/axios';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../config/external-services.config';
import {
  calculateLeaveRequestImpact,
  type LeaveRequestImpactSchedule,
} from '../../../shared/leave-request-impact';
import type { MonthlyScheduleLeaveAssignment } from '../../../shared/api.interface';
import type { LeaveOriginalPostBackfill } from '../../../shared/leave-original-post-backfill';
import { readLocalLeaveProjection, resolveLocalLeaveProjection, type LocalLeaveProjectionState } from './leave-local-projection';
import {
  type BitableRecordItem,
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractDisplayValues,
  fetchBitableRecords,
  getRecordId,
  normalizeBuildingForFrontend,
  normalizeShiftForFrontend,
  normalizeTeamForFrontend,
  pickField,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  resolveBitableTableIdByName,
} from './bitable-direct-read';

const DEFAULT_LEAVE_REQUEST_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const LEAVE_APPROVAL_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LEAVE_APPROVAL_LOCAL_MAX_AGE_MS = 30 * 60 * 1000;

export const SYSTEM_APPROVED_LEAVE_STAFF_FIELD = '__systemApprovedLeaveStaff';
export const SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD =
  '__systemApprovedSubstituteStaff';
export const SYSTEM_APPROVED_LEAVE_ASSIGNMENTS_FIELD =
  '__systemApprovedLeaveAssignments';
export const SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD =
  '__systemLeaveApprovalVerified';
export const SYSTEM_APPROVED_POST_REPLACEMENTS_FIELD = '__systemApprovedPostReplacements';
export const SYSTEM_LEAVE_APPROVAL_ERROR_FIELD = '__systemLeaveApprovalError';

export interface ApprovedPostReplacement {
  requestRecordId: string;
  removedStaff: string;
  addedStaff: string;
}

export const RAW_LEAVE_STAFF_FIELD_CANDIDATES = [
  'fld4xMPICY',
  '请假人员（请假表）',
  '请假人员',
] as const;

export const RAW_SUBSTITUTE_STAFF_FIELD_CANDIDATES = [
  'fldZnstUS3',
  '替班人员（请假表）',
  '替班人员',
  '替岗人员',
  '调岗人员',
] as const;

export const LEAVE_APPROVAL_COMPLETE_FIELD_CANDIDATES = [
  '系统审批完成标记',
  'fld1k05IQ9',
  '审批进度',
] as const;

export const LEAVE_APPROVAL_FIELD_NAMES = [
  '系统审批完成标记',
  '系统影响排班记录ID',
  '休假人员（文本）',
  '休假人员',
  '休假开始时间',
  '休假结束时间',
  '机楼',
  '班组',
  '班次（有关联）',
  '替班人员（填姓名）',
  '替班调整版本',
  '替班安排',
  '请假审批时间',
  '替班调整时间',
  '审批来源',
  '请假工作流状态',
] as const;

const LEAVE_SHIFT_DETAIL_FIELD_NAMES = [
  '请假记录ID',
  '班次键',
  '排班记录IDs',
  '替班人员姓名',
  '替班安排版本',
  '调整时间',
  '状态',
] as const;

const SCHEDULE_DATE_FIELD_CANDIDATES = [
  'fldZSaDbGf',
  '排班日期',
  '日期',
  'schedule_date',
  '排班日期（日期）',
] as const;
const SCHEDULE_BUILDING_FIELD_CANDIDATES = [
  'fldnP4gXMn',
  'fldUHstSKX',
  '机楼',
  '楼栋',
  '值守机楼',
] as const;
const SCHEDULE_TEAM_FIELD_CANDIDATES = [
  'fldE9Gwnk7',
  'fld5x9advB',
  '班组',
  '班别',
] as const;
const SCHEDULE_SHIFT_FIELD_CANDIDATES = [
  'fldqPpOgW5',
  '班次',
  '值班班次',
] as const;

export interface ApprovedLeaveRequest {
  recordId: string;
  leaveStaff: string[];
  substituteStaff: string[];
  startAt: string | null;
  endAt: string | null;
  building: string;
  team: string;
  shift: string;
  impactedScheduleRecordIds: string[];
  assignmentRevision?: number;
  invalidAssignmentRevision?: boolean;
  requiresOriginalPostMetadata?: boolean;
  approvedAt?: string | null;
  substituteAdjustedAt?: string | null;
  shiftDetails?: ApprovedLeaveShiftDetail[];
  unavailableReason?: string;
  unavailableScheduleRecordIds?: string[];
}

export interface ApprovedLeaveShiftDetail {
  shiftKey: string;
  scheduleRecordIds: string[];
  substituteStaff: string[];
  revision: number;
  updatedAt?: string | null;
  originalPostBackfills?: LeaveOriginalPostBackfill[];
  substitutePersonRecordId?: string;
  substituteOpenId?: string;
}

export interface LeaveApprovalSnapshot {
  verified: boolean;
  requests: ApprovedLeaveRequest[];
}

export interface FetchLeaveApprovalSnapshotOptions {
  forceRefresh?: boolean;
  strict?: boolean;
}

interface PersistedLeaveApprovalSnapshot {
  records: BitableRecordItem[];
  fetchedAt: number;
  expiresAt: number;
}

export interface CachedLeaveApprovalSnapshotState {
  snapshot: LeaveApprovalSnapshot;
  approvalFetchedAt: number | null;
  shiftDetailFetchedAt: number | null;
}

let cachedParsedLeaveApprovalSnapshot: {
  sourceKey: string;
  fetchedAt: number;
  shiftDetailFetchedAt: number | null;
  maxAgeMs: number;
  snapshot: LeaveApprovalSnapshot;
} | null = null;
let resolvedLeaveShiftDetailTableId = '';

export function resolveLeaveApprovalSource(): {
  appToken: string;
  wikiToken: string;
  tableId: string;
} {
  const sourceUrl =
    readEnv('FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL', [
      'FEISHU_LEAVE_REQUEST_SOURCE_URL',
    ]) || DEFAULT_LEAVE_REQUEST_SOURCE_URL;
  const parsed = parseFeishuBitableLink(sourceUrl);
  return {
    appToken:
      readEnv('FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN', [
        'FEISHU_LEAVE_REQUEST_APP_TOKEN',
      ]) || parsed.appToken,
    wikiToken:
      readEnv('FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN', [
        'FEISHU_LEAVE_REQUEST_WIKI_TOKEN',
      ]) || parsed.wikiToken,
    tableId:
      readEnv('FEISHU_LEAVE_SUBSTITUTE_TABLE_ID', [
        'FEISHU_LEAVE_REQUEST_TABLE_ID',
      ]) || parsed.tableId,
  };
}

function getLeaveApprovalLocalMaxAgeMs(): number {
  const configured = Number(process.env.FEISHU_LEAVE_APPROVAL_LOCAL_MAX_AGE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LEAVE_APPROVAL_LOCAL_MAX_AGE_MS;
}

export function buildCachedLeaveApprovalSnapshot(
  snapshot: PersistedLeaveApprovalSnapshot | null,
  nowMs = Date.now(),
  maxAgeMs = getLeaveApprovalLocalMaxAgeMs(),
  shiftDetailSnapshot: PersistedLeaveApprovalSnapshot | null = null,
  localProjection?: LocalLeaveProjectionState,
): LeaveApprovalSnapshot {
  if (
    !snapshot ||
    !Number.isFinite(snapshot.fetchedAt) ||
    snapshot.fetchedAt <= 0 ||
    nowMs - snapshot.fetchedAt > maxAgeMs
  ) {
    return { verified: false, requests: [] };
  }

  try {
    validateLeaveApprovalRecords(snapshot.records);
    const approvalSnapshot = buildLeaveApprovalSnapshot(snapshot.records);
    if (
      !shiftDetailSnapshot ||
      !Number.isFinite(shiftDetailSnapshot.fetchedAt) ||
      shiftDetailSnapshot.fetchedAt <= 0 ||
      nowMs - shiftDetailSnapshot.fetchedAt > maxAgeMs
    ) {
      return attachShiftDetails(approvalSnapshot, [], localProjection);
    }
    return attachShiftDetails(approvalSnapshot, shiftDetailSnapshot.records, localProjection);
  } catch {
    return { verified: false, requests: [] };
  }
}

export async function readCachedLeaveApprovalSnapshot(): Promise<LeaveApprovalSnapshot> {
  const state = await readCachedLeaveApprovalSnapshotState();
  return state.snapshot;
}

export async function readCachedLeaveApprovalSnapshotState(): Promise<CachedLeaveApprovalSnapshotState> {
  try {
    const source = resolveLeaveApprovalSource();
    if (!source.tableId) {
      return {
        snapshot: { verified: false, requests: [] },
        approvalFetchedAt: null,
        shiftDetailFetchedAt: null,
      };
    }
    const shiftDetailTableId =
      readEnv('FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID') ||
      resolvedLeaveShiftDetailTableId;
    const [snapshot, shiftDetailSnapshot, localProjection] = await Promise.all([
      readCompatibleLeaveRequestSnapshot(source.appToken || undefined, source.tableId),
      shiftDetailTableId
        ? readCompatibleShiftDetailSnapshot(source.appToken || undefined, shiftDetailTableId)
        : Promise.resolve(null),
      readLocalLeaveProjection(),
    ]);
    const nowMs = Date.now();
    const maxAgeMs = getLeaveApprovalLocalMaxAgeMs();
    const shiftDetailFetchedAt = shiftDetailSnapshot?.fetchedAt ?? null;
    const shiftDetailIsFresh =
      !shiftDetailTableId ||
      (shiftDetailSnapshot !== null &&
        Number.isFinite(shiftDetailSnapshot.fetchedAt) &&
        shiftDetailSnapshot.fetchedAt > 0 &&
        nowMs - shiftDetailSnapshot.fetchedAt <= maxAgeMs);
    const sourceKey = `${source.appToken}:${source.tableId}:${shiftDetailTableId}:${localProjection.fingerprint}`;
    if (
      snapshot &&
      cachedParsedLeaveApprovalSnapshot &&
      cachedParsedLeaveApprovalSnapshot.sourceKey === sourceKey &&
      cachedParsedLeaveApprovalSnapshot.fetchedAt === snapshot.fetchedAt &&
      cachedParsedLeaveApprovalSnapshot.shiftDetailFetchedAt ===
        shiftDetailFetchedAt &&
      cachedParsedLeaveApprovalSnapshot.maxAgeMs === maxAgeMs &&
      nowMs - snapshot.fetchedAt <= maxAgeMs &&
      shiftDetailIsFresh
    ) {
      return {
        snapshot: cachedParsedLeaveApprovalSnapshot.snapshot,
        approvalFetchedAt: snapshot.fetchedAt,
        shiftDetailFetchedAt,
      };
    }

    const parsedSnapshot: LeaveApprovalSnapshot = shiftDetailIsFresh
      ? buildCachedLeaveApprovalSnapshot(
          snapshot,
          nowMs,
          maxAgeMs,
          shiftDetailSnapshot,
          localProjection,
        )
      : { verified: false, requests: [] };
    if (
      snapshot &&
      Number.isFinite(snapshot.fetchedAt) &&
      snapshot.fetchedAt > 0 &&
      nowMs - snapshot.fetchedAt <= maxAgeMs &&
      shiftDetailIsFresh
    ) {
      cachedParsedLeaveApprovalSnapshot = {
        sourceKey,
        fetchedAt: snapshot.fetchedAt,
        shiftDetailFetchedAt,
        maxAgeMs,
        snapshot: parsedSnapshot,
      };
    } else {
      cachedParsedLeaveApprovalSnapshot = null;
    }
    return {
      snapshot: parsedSnapshot,
      approvalFetchedAt: snapshot?.fetchedAt ?? null,
      shiftDetailFetchedAt,
    };
  } catch {
    return {
      snapshot: { verified: false, requests: [] },
      approvalFetchedAt: null,
      shiftDetailFetchedAt: null,
    };
  }
}

export function buildLeaveApprovalSnapshot(
  records: BitableRecordItem[],
  verified = true,
): LeaveApprovalSnapshot {
  if (!verified) {
    return { verified: false, requests: [] };
  }

  return {
    verified: true,
    requests: records
      .map(mapApprovedLeaveRequest)
      .filter((request): request is ApprovedLeaveRequest => Boolean(request)),
  };
}

export async function fetchLeaveApprovalSnapshot(
  httpService: HttpService,
  options: FetchLeaveApprovalSnapshotOptions = {},
): Promise<LeaveApprovalSnapshot> {
  try {
    const source = resolveLeaveApprovalSource();
    const appToken = await resolveBitableAppToken(httpService, {
      appToken: source.appToken,
      wikiToken: source.wikiToken,
      tableName: '请休假审批状态',
    });
    const records = await fetchBitableRecords(httpService, {
      appToken,
      tableId: source.tableId,
      tableName: '请休假审批状态',
      fieldNames: [...LEAVE_APPROVAL_FIELD_NAMES],
      cacheTtlMs: LEAVE_APPROVAL_CACHE_TTL_MS,
      forceRefresh: Boolean(options.forceRefresh),
      allowStale: false,
      strict: true,
      validateRecords: validateLeaveApprovalRecords,
    });
    if (!Array.isArray(records)) {
      throw new Error('请休假审批状态返回格式无效');
    }
    const snapshot = buildLeaveApprovalSnapshot(records);
    if (snapshot.requests.length === 0) return snapshot;
    const detailTableId =
      readEnv('FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID') ||
      (await resolveBitableTableIdByName(httpService, {
        appToken,
        tableName: '请假替班班次明细',
      }));
    resolvedLeaveShiftDetailTableId = detailTableId;
    const [detailRecords, localProjection] = await Promise.all([fetchBitableRecords(httpService, {
      appToken,
      tableId: detailTableId,
      tableName: '请假替班班次明细',
      cacheTtlMs: LEAVE_APPROVAL_CACHE_TTL_MS,
      forceRefresh: Boolean(options.forceRefresh),
      allowStale: false,
      strict: true,
    }), readLocalLeaveProjection()]);
    return attachShiftDetails(snapshot, detailRecords, localProjection);
  } catch (error) {
    if (options.strict) {
      throw error;
    }
    return { verified: false, requests: [] };
  }
}

async function readCompatibleShiftDetailSnapshot(appToken: string | undefined, tableId: string): Promise<PersistedLeaveApprovalSnapshot | null> {
  const options = { appToken, tableId, tableName: '请假替班班次明细' };
  // The new column is optional on historical tables; full records do not request missing names.
  const full = await readLatestPersistedBitableRecordSnapshot(options);
  if (full && Date.now() - full.fetchedAt <= getLeaveApprovalLocalMaxAgeMs()) return full;
  return readLatestPersistedBitableRecordSnapshot({ ...options, fieldNames: LEAVE_SHIFT_DETAIL_FIELD_NAMES });
}

async function readCompatibleLeaveRequestSnapshot(appToken: string | undefined, tableId: string): Promise<PersistedLeaveApprovalSnapshot | null> {
  const options = { appToken, tableId, tableName: '请休假审批状态' };
  const current = await readLatestPersistedBitableRecordSnapshot({ ...options, fieldNames: LEAVE_APPROVAL_FIELD_NAMES });
  if (current && Date.now() - current.fetchedAt <= getLeaveApprovalLocalMaxAgeMs()) return current;
  return readLatestPersistedBitableRecordSnapshot({ ...options, fieldNames: LEAVE_APPROVAL_FIELD_NAMES.filter((name) => name !== '替班安排') });
}

export function enrichScheduleRecordsWithLeaveApproval(
  records: BitableRecordItem[],
  snapshot: LeaveApprovalSnapshot,
): BitableRecordItem[] {
  const replacementsByRecord = new Map<string, ApprovedPostReplacement[]>();
  const errorsByRecord = new Map<string, string>();
  const addReplacement = (recordId: string, replacement: ApprovedPostReplacement) => {
    const current = replacementsByRecord.get(recordId) || [];
    if (current.some((item) => item.removedStaff === replacement.removedStaff && (item.addedStaff !== replacement.addedStaff || item.requestRecordId !== replacement.requestRecordId))) throw new Error('原岗补位安排冲突，请核对审批记录');
    if (!current.some((item) => item.removedStaff === replacement.removedStaff && item.addedStaff === replacement.addedStaff)) current.push(replacement);
    replacementsByRecord.set(recordId, current);
  };
  const requestsByLeaveStaff = snapshot.verified
    ? indexApprovedRequestsByLeaveStaff(snapshot.requests, (request) => {
      if (request.unavailableReason) {
        for (const id of request.unavailableScheduleRecordIds || request.impactedScheduleRecordIds) errorsByRecord.set(id, request.unavailableReason);
        return;
      }
      for (const detail of request.shiftDetails || []) {
        if (!detail.originalPostBackfills?.length || detail.revision !== (request.assignmentRevision || 0)) continue;
        if (request.leaveStaff.length !== 1 || detail.substituteStaff.length !== 1) throw new Error('原岗补位对应人员不唯一');
        const primary = detail.substituteStaff[0];
        for (const recordId of detail.scheduleRecordIds) addReplacement(recordId, { requestRecordId: request.recordId, removedStaff: request.leaveStaff[0], addedStaff: primary });
        for (const backup of detail.originalPostBackfills) {
          if (!backup.substituteOpenId || !backup.substitutePersonRecordId || !backup.substituteName || !backup.group.scheduleRecordIds.length || backup.substituteName === primary) throw new Error('原岗补位安排不完整');
          for (const recordId of backup.group.scheduleRecordIds) {
            if (detail.scheduleRecordIds.includes(recordId)) throw new Error('原岗与请假岗位不能是同一排班记录');
            addReplacement(recordId, { requestRecordId: request.recordId, removedStaff: primary, addedStaff: backup.substituteName });
          }
        }
      }
    })
    : null;
  return records.map((record) => {
    const error = errorsByRecord.get(getRecordId(record));
    const visibility = requestsByLeaveStaff
      ? resolveApprovedVisibilityForSchedule(record, requestsByLeaveStaff)
      : { leaveStaff: [], substituteStaff: [], leaveAssignments: [] };
    return {
      ...record,
      fields: {
        ...(record.fields || {}),
        [SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD]: snapshot.verified && !error,
        [SYSTEM_LEAVE_APPROVAL_ERROR_FIELD]: error || '',
        [SYSTEM_APPROVED_LEAVE_STAFF_FIELD]: visibility.leaveStaff,
        [SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]: visibility.substituteStaff,
        [SYSTEM_APPROVED_LEAVE_ASSIGNMENTS_FIELD]: visibility.leaveAssignments,
        [SYSTEM_APPROVED_POST_REPLACEMENTS_FIELD]: replacementsByRecord.get(getRecordId(record)) || [],
      },
    };
  });
}

export function readApprovedLeaveAssignmentsFromFields(
  fields: Record<string, unknown>,
): MonthlyScheduleLeaveAssignment[] {
  if (fields[SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD] !== true) return [];
  const value = fields[SYSTEM_APPROVED_LEAVE_ASSIGNMENTS_FIELD];
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const assignment = item as Record<string, unknown>;
    const requestRecordId = String(assignment.requestRecordId || '').trim();
    const leaveStaffName = String(assignment.leaveStaffName || '').trim();
    if (!requestRecordId || !leaveStaffName) return [];
    const leaveHours = assignment.leaveHours;
    return [
      {
        requestRecordId,
        leaveStaffName,
        substituteStaff: dedupeStaffNames(
          Array.isArray(assignment.substituteStaff)
            ? assignment.substituteStaff.map(String)
            : [],
        ),
        startAt:
          typeof assignment.startAt === 'string' ? assignment.startAt : null,
        endAt: typeof assignment.endAt === 'string' ? assignment.endAt : null,
        leaveHours:
          typeof leaveHours === 'number' && Number.isFinite(leaveHours)
            ? leaveHours
            : null,
      },
    ];
  });
}

function validateLeaveApprovalRecords(records: BitableRecordItem[]): void {
  if (records.length === 0) return;
  const hasVisibleMarker = records.some((record) =>
    Object.prototype.hasOwnProperty.call(
      record.fields || {},
      '系统审批完成标记',
    ),
  );
  if (!hasVisibleMarker) {
    throw new Error('请休假审批完成标记不可用');
  }
}

function mapApprovedLeaveRequest(
  record: BitableRecordItem,
): ApprovedLeaveRequest | null {
  const fields = record.fields || {};
  if (!isApprovalComplete(fields)) return null;

  const leaveStaff = extractStaffNames(
    pickField(fields, ['休假人员（文本）', '休假人员']),
  );
  if (leaveStaff.length === 0) return null;
  const revisionText = extractDisplayText(pickField(fields, ['替班调整版本'])).trim();
  const invalidAssignmentRevision = revisionText !== '' && (!Number.isSafeInteger(Number(revisionText)) || Number(revisionText) < 0);

  return {
    recordId: getRecordId(record),
    leaveStaff,
    substituteStaff: extractStaffNames(
      pickField(fields, ['替班人员（填姓名）']),
    ),
    startAt: formatShanghaiLocalDateTime(pickField(fields, ['休假开始时间'])),
    endAt: formatShanghaiLocalDateTime(pickField(fields, ['休假结束时间'])),
    building: extractDisplayText(pickField(fields, ['机楼'])),
    team: extractDisplayText(pickField(fields, ['班组'])),
    shift: extractDisplayText(pickField(fields, ['班次（有关联）', '班次'])),
    impactedScheduleRecordIds: extractStaffNames(
      pickField(fields, ['系统影响排班记录ID']),
    ),
    assignmentRevision: readNonNegativeInteger(
      pickField(fields, ['替班调整版本']),
    ),
    ...(invalidAssignmentRevision ? { invalidAssignmentRevision: true } : {}),
    approvedAt: extractDateTimeIso(pickField(fields, ['请假审批时间'])) || null,
    substituteAdjustedAt:
      extractDateTimeIso(pickField(fields, ['替班调整时间'])) || null,
    ...(extractDisplayText(pickField(fields, ['替班安排'])).includes('原岗补位 ') ? { requiresOriginalPostMetadata: true } : {}),
  };
}

function attachShiftDetails(
  snapshot: LeaveApprovalSnapshot,
  records: BitableRecordItem[],
  localProjection?: LocalLeaveProjectionState,
): LeaveApprovalSnapshot {
  const detailsByLeaveRecordId = new Map<string, ApprovedLeaveShiftDetail[]>();
  const legacyMetadataRequests = new Set<string>();
  for (const record of records) {
    const fields = record.fields || {};
    if (extractDisplayText(pickField(fields, ['状态'])).trim() !== 'active') {
      continue;
    }
    const leaveRecordId = extractDisplayText(
      pickField(fields, ['请假记录ID']),
    ).trim();
    if (extractDisplayText(pickField(fields, ['原岗补位安排']))) legacyMetadataRequests.add(leaveRecordId);
    const shiftKey = extractDisplayText(pickField(fields, ['班次键'])).trim();
    const detailRevisionText = extractDisplayText(pickField(fields, ['替班安排版本'])).trim();
    if (detailRevisionText !== '' && (!Number.isSafeInteger(Number(detailRevisionText)) || Number(detailRevisionText) < 0)) continue;
    const revision = readNonNegativeInteger(
      pickField(fields, ['替班安排版本']),
    );
    const scheduleRecordIds = extractRecordIds(
      pickField(fields, ['排班记录IDs']),
    );
    const substituteStaff = extractStaffNames(
      pickField(fields, ['替班人员姓名']),
    );
    const updatedAt =
      extractDateTimeIso(pickField(fields, ['调整时间'])) || null;
    if (!leaveRecordId || !shiftKey || scheduleRecordIds.length === 0) continue;
    const detail = {
      shiftKey,
      scheduleRecordIds,
      substituteStaff,
      revision,
      updatedAt,
      substitutePersonRecordId: extractDisplayText(pickField(fields, ['替班人员记录ID'])).trim(),
      substituteOpenId: extractDisplayText(pickField(fields, ['替班人员OpenID'])).trim(),
    };
    const current = detailsByLeaveRecordId.get(leaveRecordId) || [];
    current.push(detail);
    detailsByLeaveRecordId.set(leaveRecordId, current);
  }
  return {
    verified: snapshot.verified,
    requests: snapshot.requests.map((request) => {
      const details = detailsByLeaveRecordId.get(request.recordId);
      const revision = request.assignmentRevision || 0;
      const current = details?.filter((detail) => detail.revision === revision);
      const candidate = {
        ...request,
        ...(current ? { shiftDetails: current } : {}),
      };
      const result = resolveLocalLeaveProjection(localProjection || { fingerprint: 'not-loaded', applications: new Map(), actions: new Map(), updates: new Map(), error: '原岗补位台账尚未读取' }, { ...candidate, ...(legacyMetadataRequests.has(request.recordId) ? { requiresOriginalPostMetadata: true } : {}) });
      if (result.kind === 'unavailable') return { ...candidate, substituteStaff: [], shiftDetails: [], unavailableReason: result.reason, unavailableScheduleRecordIds: result.scheduleRecordIds };
      if (result.kind === 'none') return candidate;
      const byShift = new Map(result.assignments.map(assignment => [assignment.shiftKey, assignment]));
      return { ...candidate, shiftDetails: (current || []).map(detail => ({ ...detail, ...(byShift.get(detail.shiftKey)?.originalPostBackfills?.length ? { originalPostBackfills: byShift.get(detail.shiftKey)!.originalPostBackfills } : {}) })) };
    }),
  };
}

function extractRecordIds(field: unknown): string[] {
  const values = extractDisplayValues(field);
  const result: string[] = [];
  for (const value of values) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        result.push(...parsed.map(String));
        continue;
      }
    } catch {
      // Fall through to the legacy delimiter representation.
    }
    result.push(...value.split(/[\s、,，;；/]+/u));
  }
  return [
    ...new Set(
      result
        .map((item) => item.trim().replace(/^[\["']+|[\]"']+$/gu, ''))
        .filter((item) => /^[A-Za-z0-9_-]{1,100}$/u.test(item)),
    ),
  ];
}

function readNonNegativeInteger(field: unknown): number {
  const value = Number(extractDisplayText(field).trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function indexApprovedRequestsByLeaveStaff(
  requests: ApprovedLeaveRequest[],
  visitRequest?: (request: ApprovedLeaveRequest) => void,
): Map<string, ApprovedLeaveRequest[]> {
  const result = new Map<string, ApprovedLeaveRequest[]>();
  for (const request of requests) {
    visitRequest?.(request);
    if (request.unavailableReason) continue;
    for (const leaveName of request.leaveStaff) {
      const key = normalizeStaffName(leaveName);
      if (!key) continue;
      const existing = result.get(key);
      if (existing) {
        existing.push(request);
      } else {
        result.set(key, [request]);
      }
    }
  }
  return result;
}

function resolveApprovedVisibilityForSchedule(
  record: BitableRecordItem,
  requestsByLeaveStaff: ReadonlyMap<string, ApprovedLeaveRequest[]>,
): {
  leaveStaff: string[];
  substituteStaff: string[];
  leaveAssignments: MonthlyScheduleLeaveAssignment[];
} {
  const fields = record.fields || {};
  const rawLeaveStaff = extractStaffNames(
    pickField(fields, [...RAW_LEAVE_STAFF_FIELD_CANDIDATES]),
  );
  if (rawLeaveStaff.length === 0) {
    return { leaveStaff: [], substituteStaff: [], leaveAssignments: [] };
  }

  const approvedLeaveStaff: string[] = [];
  const approvedSubstituteStaff: string[] = [];
  const leaveAssignments: MonthlyScheduleLeaveAssignment[] = [];
  for (const leaveName of rawLeaveStaff) {
    const matchingRequests = (
      requestsByLeaveStaff.get(normalizeStaffName(leaveName)) || []
    ).filter((request) => requestAffectsSchedule(request, record, leaveName));
    if (matchingRequests.length === 0) continue;

    approvedLeaveStaff.push(leaveName);
    matchingRequests.forEach((request) => {
      const assignment = buildApprovedLeaveAssignment(
        request,
        record,
        leaveName,
      );
      if (!assignment) return;
      approvedSubstituteStaff.push(...assignment.substituteStaff);
      leaveAssignments.push(assignment);
    });
  }

  return {
    leaveStaff: dedupeStaffNames(approvedLeaveStaff),
    substituteStaff: dedupeStaffNames(approvedSubstituteStaff),
    leaveAssignments: dedupeLeaveAssignments(leaveAssignments),
  };
}

function buildApprovedLeaveAssignment(
  request: ApprovedLeaveRequest,
  record: BitableRecordItem,
  leaveStaffName: string,
): MonthlyScheduleLeaveAssignment | null {
  if (!requestAffectsSchedule(request, record, leaveStaffName)) return null;

  const scheduleRecordId = getRecordId(record);
  const substituteStaff = request.shiftDetails
    ? dedupeStaffNames(
        request.shiftDetails
          .filter((detail) =>
            detail.scheduleRecordIds.includes(scheduleRecordId),
          )
          .flatMap((detail) => detail.substituteStaff),
      )
    : dedupeStaffNames(request.substituteStaff);
  const schedule = buildLeaveImpactSchedule(record, leaveStaffName);
  const impact =
    schedule && request.startAt && request.endAt
      ? calculateLeaveRequestImpact([schedule], {
          leaveStaffName,
          startAt: request.startAt,
          endAt: request.endAt,
        })
      : null;

  return {
    requestRecordId: request.recordId,
    leaveStaffName,
    substituteStaff,
    startAt: request.startAt,
    endAt: request.endAt,
    leaveHours:
      impact?.affectedSchedules.find(
        (affected) => affected.recordId === scheduleRecordId,
      )?.leaveHours ?? null,
  };
}

function dedupeLeaveAssignments(
  assignments: MonthlyScheduleLeaveAssignment[],
): MonthlyScheduleLeaveAssignment[] {
  const seen = new Set<string>();
  return assignments.filter((assignment) => {
    const key = `${assignment.requestRecordId}:${normalizeStaffName(
      assignment.leaveStaffName,
    )}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildLeaveImpactSchedule(
  scheduleRecord: BitableRecordItem,
  leaveName: string,
): LeaveRequestImpactSchedule | null {
  const recordId = getRecordId(scheduleRecord);
  const fields = scheduleRecord.fields || {};
  const scheduleDate = extractDateValue(
    pickField(fields, [...SCHEDULE_DATE_FIELD_CANDIDATES]),
  );
  if (!recordId || !scheduleDate) return null;

  const buildingText = extractDisplayText(
    pickField(fields, [...SCHEDULE_BUILDING_FIELD_CANDIDATES]),
  );
  const teamText = extractDisplayText(
    pickField(fields, [...SCHEDULE_TEAM_FIELD_CANDIDATES]),
  );
  const shiftText = extractDisplayText(
    pickField(fields, [...SCHEDULE_SHIFT_FIELD_CANDIDATES]),
  );
  return {
    recordId,
    scheduleDate,
    building: normalizeBuildingForFrontend(buildingText),
    buildingText,
    team: normalizeTeamForFrontend(teamText),
    teamText,
    shift: normalizeShiftForFrontend(shiftText),
    shiftText,
    dutyStaffActual: [leaveName],
  };
}

function requestAffectsSchedule(
  request: ApprovedLeaveRequest,
  scheduleRecord: BitableRecordItem,
  leaveName: string,
): boolean {
  const scheduleRecordId = getRecordId(scheduleRecord);
  if (request.impactedScheduleRecordIds.length > 0) {
    return request.impactedScheduleRecordIds.includes(scheduleRecordId);
  }
  if (!request.startAt || !request.endAt || !scheduleRecordId) return false;

  const schedule = buildLeaveImpactSchedule(scheduleRecord, leaveName);
  if (!schedule) return false;

  if (
    !scopeMatches(
      request.building,
      schedule.buildingText || '',
      normalizeBuildingForFrontend,
    ) ||
    !scopeMatches(
      request.team,
      schedule.teamText || '',
      normalizeTeamForFrontend,
    ) ||
    !scopeMatches(
      request.shift,
      schedule.shiftText || '',
      normalizeShiftForFrontend,
    )
  ) {
    return false;
  }

  const impact = calculateLeaveRequestImpact([schedule], {
    leaveStaffName: leaveName,
    startAt: request.startAt,
    endAt: request.endAt,
  });
  return impact.affectedSchedules.some(
    (affected) => affected.recordId === scheduleRecordId,
  );
}

function scopeMatches(
  expected: string,
  actual: string,
  normalize: (value: string) => string,
): boolean {
  if (!expected || !actual) return true;
  return normalize(expected) === normalize(actual);
}

function isApprovalComplete(fields: Record<string, unknown>): boolean {
  const approvalSource = extractDisplayText(pickField(fields, ['审批来源']))
    .trim()
    .replace(/\s+/g, '');
  if (approvalSource === '程序卡片') {
    return (
      extractDisplayText(pickField(fields, ['请假工作流状态']))
        .trim()
        .replace(/\s+/g, '') === '已审批'
    );
  }

  return (
    extractDisplayText(
      pickField(fields, [...LEAVE_APPROVAL_COMPLETE_FIELD_CANDIDATES]),
    )
      .trim()
      .replace(/\s+/g, '') === '审批结束'
  );
}

function formatShanghaiLocalDateTime(field: unknown): string | null {
  const iso = extractDateTimeIso(field);
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || '';
  const minute = get('minute');
  if (minute !== '00') return null;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${minute}`;
}

function extractStaffNames(field: unknown): string[] {
  return dedupeStaffNames(
    extractDisplayValues(field)
      .flatMap((value) => value.split(/[\s、,，;；/]+/))
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function dedupeStaffNames(names: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  names.forEach((name) => {
    const key = normalizeStaffName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(name.trim());
  });
  return result;
}

function normalizeStaffName(value: string): string {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}
