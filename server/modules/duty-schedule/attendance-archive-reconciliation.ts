import { createHash } from 'node:crypto';
import {
  extractDisplayText,
  getRecordId,
  type BitableRecordItem,
} from '@server/common/feishu/bitable-direct-read';

export interface ReconciledAttendanceRow {
  key: string;
  fields: Record<string, unknown>;
  recordId?: string;
  expectationKey?: string;
  requiresEvidence?: boolean;
}

export interface ReconcileAttendanceRowsOptions {
  includeExistingOnlyDuplicates?: boolean;
}

const text = (value: unknown): string => extractDisplayText(value, '').trim();

interface AttendanceShiftIdentity {
  businessKey: string;
  buildingCode: string;
  date: string;
  label: string;
  personDateKey: string;
  shiftCode: string;
  userId: string;
}

interface AttendanceRawPunch {
  direction: 'OnDuty' | 'OffDuty';
  invalidReason?: string;
  recordId?: string;
  userCheckTime: number;
}

/** A punch result's identity must not change when DingTalk replaces its ID or timestamp. */
export function attendanceBusinessKey(
  fields: Record<string, unknown>,
): string | undefined {
  if (!['考勤结果', '打卡明细'].includes(text(fields.记录类型)))
    return undefined;
  return resolveAttendanceShiftIdentity(fields)?.businessKey;
}

export function reconcileAttendanceRows(
  incoming: readonly ReconciledAttendanceRow[],
  existing: readonly BitableRecordItem[],
  options: ReconcileAttendanceRowsOptions = {},
): {
  rows: ReconciledAttendanceRow[];
  duplicates: BitableRecordItem[];
  originals: BitableRecordItem[];
} {
  const groups = new Map<
    string,
    { incoming: ReconciledAttendanceRow[]; existing: BitableRecordItem[] }
  >();
  const rows: ReconciledAttendanceRow[] = [];
  const duplicates: BitableRecordItem[] = [];
  const originals: BitableRecordItem[] = [];
  const group = (key: string) => {
    if (!groups.has(key)) groups.set(key, { incoming: [], existing: [] });
    return groups.get(key)!;
  };
  const shiftKeysByPersonDate = new Map<string, Set<string>>();
  const registerIdentity = (identity: AttendanceShiftIdentity | undefined) => {
    if (!identity) return;
    const keys =
      shiftKeysByPersonDate.get(identity.personDateKey) || new Set<string>();
    keys.add(identity.businessKey);
    shiftKeysByPersonDate.set(identity.personDateKey, keys);
  };
  incoming.forEach((row) =>
    registerIdentity(resolveAttendanceShiftIdentity(row.fields)),
  );
  existing.forEach((record) =>
    registerIdentity(resolveAttendanceShiftIdentity(record.fields || {})),
  );
  for (const row of incoming) {
    if (!isAttendanceArchiveRow(row.fields)) {
      rows.push(row);
      continue;
    }
    const identity = resolveAttendanceShiftIdentity(row.fields);
    const personDateKey = attendancePersonDateKey(row.fields);
    const candidates = personDateKey
      ? shiftKeysByPersonDate.get(personDateKey)
      : undefined;
    const key =
      identity?.businessKey ||
      (candidates?.size === 1
        ? [...candidates][0]
        : candidates && candidates.size > 1
          ? `attendance-ambiguous-incoming-${row.key}`
          : fallbackAttendanceBusinessKey(row.fields));
    if (key) group(key).incoming.push(row);
    else rows.push(row);
  }
  for (const record of existing) {
    const fields = record.fields || {};
    if (!isAttendanceArchiveRow(fields)) continue;
    const identity = resolveAttendanceShiftIdentity(fields);
    let key = identity?.businessKey;
    if (!key) {
      const personDateKey = attendancePersonDateKey(fields);
      const candidates = personDateKey
        ? shiftKeysByPersonDate.get(personDateKey)
        : undefined;
      if (candidates?.size === 1) key = [...candidates][0];
      else if (candidates && candidates.size > 1) {
        // Ambiguous legacy rows must not be merged or deleted speculatively.
        key = `attendance-ambiguous-${getRecordId(record)}`;
      } else key = fallbackAttendanceBusinessKey(fields);
    }
    if (key && getRecordId(record)) group(key).existing.push(record);
  }
  for (const [key, items] of groups) {
    if (
      !items.incoming.length &&
      (!options.includeExistingOnlyDuplicates || items.existing.length < 2)
    ) {
      continue;
    }
    const candidates = [
      ...items.existing.map((record) => record.fields || {}),
      ...items.incoming.map((row) => row.fields),
    ];
    // Prefer a valid actual punch; never rank Normal above Late/Early.
    const selected = candidates.reduce((best, next) =>
      rank(next) >= rank(best) ? next : best,
    );
    const identity = candidates
      .map(resolveAttendanceShiftIdentity)
      .find((value): value is AttendanceShiftIdentity => Boolean(value));
    const fields = buildAggregatedFields(candidates, selected, key, identity);
    const original = Object.assign(
      {},
      ...candidates.map((item) => parseOriginal(item.原始记录JSON)),
      parseOriginal(selected.原始记录JSON),
    );
    const checks = new Map<string, Record<string, any>>();
    for (const candidate of candidates) {
      const values = parseOriginal(candidate.原始记录JSON).attendanceChecks;
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const eventKey = value?.expectation?.key;
        if (typeof eventKey !== 'string')
          throw new Error('考勤核验明细缺少事件标识');
        const previous = checks.get(eventKey);
        if (shouldReplaceAttendanceCheck(previous, value))
          checks.set(eventKey, value);
      }
    }
    if (checks.size) original.attendanceChecks = [...checks.values()];
    const rawPunches = collectRawPunches(candidates);
    if (rawPunches.length) {
      original.rawPunches = rawPunches.map((punch) => ({
        ...(punch.recordId ? { recordId: punch.recordId } : {}),
        direction: punch.direction,
        userCheckTime: punch.userCheckTime,
        ...(punch.invalidReason ? { invalidReason: punch.invalidReason } : {}),
      }));
    }
    if (identity) {
      original.attendanceShiftKey = [
        identity.date,
        identity.buildingCode,
        identity.shiftCode,
      ].join(':');
    }
    fields.原始记录JSON = JSON.stringify(original);
    for (const name of [
      '应打卡时间',
      '姓名',
      '打卡地址',
      '经度',
      '纬度',
      '外勤备注',
      '设备ID',
    ]) {
      if (fields[name] === undefined || fields[name] === '') {
        fields[name] = [...candidates]
          .reverse()
          .find((item) => item[name] !== undefined && item[name] !== '')?.[
          name
        ];
      }
    }
    const attachments = new Map<string, { file_token: string }>();
    for (const candidate of candidates) {
      if (Array.isArray(candidate.补卡举证材料))
        for (const item of candidate.补卡举证材料) {
          if (item && typeof item.file_token === 'string')
            attachments.set(item.file_token, { file_token: item.file_token });
        }
    }
    if (attachments.size) fields.补卡举证材料 = [...attachments.values()];
    // Keep an existing canonical row if present so retries retain the same Bitable record ID.
    const keeper =
      items.existing.find(
        (record) => text(record.fields?.记录唯一键) === key,
      ) || items.existing[0];
    const expectationKey = text(original.expectationKey);
    rows.push({
      key,
      fields: normalizeAttendanceWriteFields(fields),
      ...(keeper ? { recordId: getRecordId(keeper) } : {}),
      ...(expectationKey ? { expectationKey } : {}),
    });
    if (items.existing.length > 1) {
      originals.push(...items.existing);
      duplicates.push(...items.existing.filter((record) => record !== keeper));
    }
  }
  return { rows, duplicates, originals };
}

export function attendanceFieldsMatch(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean {
  return (
    [
      '记录唯一键',
      '钉钉员工ID',
      '班次',
      '打卡类型',
      '时间状态',
      '上班状态',
      '下班状态',
      '全部打卡时间',
      '是否合法',
      '补卡异常说明',
    ].every((key) => text(expected[key]) === text(actual[key])) &&
    [
      '工作日期',
      '应打卡时间',
      '实际打卡时间',
      '上班打卡时间',
      '下班打卡时间',
    ].every((key) => timestamp(expected[key]) === timestamp(actual[key])) &&
    Number(expected.打卡次数 || 0) === Number(actual.打卡次数 || 0) &&
    JSON.stringify(
      parseOriginal(expected.原始记录JSON).attendanceChecks || [],
    ) ===
      JSON.stringify(
        parseOriginal(actual.原始记录JSON).attendanceChecks || [],
      ) &&
    evidenceTokens(expected.补卡举证材料).every((token) =>
      evidenceTokens(actual.补卡举证材料).includes(token),
    )
  );
}

function buildAggregatedFields(
  candidates: readonly Record<string, unknown>[],
  selected: Record<string, unknown>,
  key: string,
  identity: AttendanceShiftIdentity | undefined,
): Record<string, unknown> {
  const punches = collectRawPunches(candidates);
  const punchTimes = (direction: 'OnDuty' | 'OffDuty'): number[] => {
    const matching = punches.filter((punch) => punch.direction === direction);
    const valid = matching.filter((punch) => !punch.invalidReason);
    return (valid.length ? valid : matching).map(
      (punch) => punch.userCheckTime,
    );
  };
  const onDutyTimes = punchTimes('OnDuty');
  const offDutyTimes = punchTimes('OffDuty');
  const checks = collectAttendanceChecks(candidates);
  const expectedTimes = checks
    .map((check) => timestamp(check?.expectation?.expectedAt))
    .filter((value) => value > 0);
  const onDutyStatus = directionStatus(candidates, checks, punches, 'OnDuty');
  const offDutyStatus = directionStatus(candidates, checks, punches, 'OffDuty');
  const status =
    onDutyStatus || offDutyStatus
      ? overallStatus(onDutyStatus, offDutyStatus)
      : text(selected.时间状态);
  const hasIllegalCandidate =
    Boolean(text(selected.无效原因)) ||
    Boolean(text(selected.补卡异常说明)) ||
    (text(selected.是否合法) === '否' &&
      timestamp(selected.实际打卡时间) === 0);
  const earliestOnDuty = onDutyTimes.length ? Math.min(...onDutyTimes) : 0;
  const latestOffDuty = offDutyTimes.length ? Math.max(...offDutyTimes) : 0;
  const actualFallback = earliestOnDuty || latestOffDuty;
  const date = workDate(selected.工作日期) || identity?.date || '';
  const name = text(selected.姓名);
  const shiftLabel = identity?.label || text(selected.班次);
  return {
    ...selected,
    文本: [date, name, shiftLabel || '班次', status].filter(Boolean).join(' '),
    记录唯一键: key,
    记录类型: '考勤结果',
    班次: shiftLabel,
    打卡类型: '班次汇总',
    应打卡时间:
      expectedTimes.length > 0
        ? Math.min(...expectedTimes)
        : timestamp(selected.应打卡时间),
    实际打卡时间:
      actualFallback || timestamp(selected.实际打卡时间) || undefined,
    上班打卡时间: earliestOnDuty || undefined,
    下班打卡时间: latestOffDuty || undefined,
    上班状态: onDutyStatus,
    下班状态: offDutyStatus,
    时间状态: status,
    打卡次数: punches.length,
    全部打卡时间: punches
      .map((punch) => formatShanghaiTime(punch.userCheckTime))
      .join('、'),
    是否合法:
      hasIllegalCandidate ||
      status === '未打卡' ||
      status === '旷工' ||
      status === '考勤异常'
        ? '否'
        : '是',
  };
}

function collectAttendanceChecks(
  candidates: readonly Record<string, unknown>[],
): Record<string, any>[] {
  const checks = new Map<string, Record<string, any>>();
  for (const candidate of candidates) {
    const values = parseOriginal(candidate.原始记录JSON).attendanceChecks;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const eventKey = value?.expectation?.key;
      if (typeof eventKey !== 'string') continue;
      const previous = checks.get(eventKey);
      if (shouldReplaceAttendanceCheck(previous, value)) {
        checks.set(eventKey, value);
      }
    }
  }
  return [...checks.values()];
}

function shouldReplaceAttendanceCheck(
  previous: Record<string, any> | undefined,
  next: Record<string, any>,
): boolean {
  if (!previous) return true;
  const previousTime = timestamp(previous.userCheckTime);
  const nextTime = timestamp(next?.userCheckTime);
  if (!previousTime) return Boolean(nextTime) || !previous.userCheckTime;
  if (!nextTime) return false;
  const direction = String(next?.expectation?.direction || '');
  return direction === 'OnDuty'
    ? nextTime < previousTime
    : direction === 'OffDuty'
      ? nextTime > previousTime
      : nextTime >= previousTime;
}

function collectRawPunches(
  candidates: readonly Record<string, unknown>[],
): AttendanceRawPunch[] {
  const punches = new Map<string, AttendanceRawPunch>();
  const timeDirectionPairs = new Set<string>();
  const directionsWithValidRawPunches = new Set<'OnDuty' | 'OffDuty'>();
  const inferredDirections = new Set(
    collectAttendanceChecks(candidates)
      .map((check) => normalizeDirection(check?.expectation?.direction))
      .filter((direction): direction is 'OnDuty' | 'OffDuty' =>
        Boolean(direction),
      ),
  );
  const inferredDirection =
    inferredDirections.size === 1 ? [...inferredDirections][0] : undefined;
  for (const candidate of candidates) {
    const original = parseOriginal(candidate.原始记录JSON);
    const values = Array.isArray(original.rawPunches)
      ? original.rawPunches
      : [];
    for (const value of values) {
      const userCheckTime = timestamp(value?.userCheckTime);
      const direction =
        normalizeDirection(value?.direction ?? value?.checkType) ||
        inferredDirection;
      if (!userCheckTime || !direction) continue;
      const recordId = text(value?.recordId ?? value?.id);
      const punch: AttendanceRawPunch = {
        direction,
        userCheckTime,
        ...(recordId ? { recordId } : {}),
        ...(text(value?.invalidReason ?? value?.invalidRecordMsg)
          ? {
              invalidReason: text(
                value?.invalidReason ?? value?.invalidRecordMsg,
              ),
            }
          : {}),
      };
      const pair = `${direction}:${userCheckTime}`;
      const punchKey = recordId ? `record:${recordId}` : `time:${pair}`;
      punches.set(punchKey, punch);
      timeDirectionPairs.add(pair);
      if (!punch.invalidReason) directionsWithValidRawPunches.add(direction);
    }
  }
  for (const candidate of candidates) {
    const userCheckTime = timestamp(candidate.实际打卡时间);
    const direction = normalizeDirection(candidate.打卡类型);
    if (!userCheckTime || !direction) continue;
    if (directionsWithValidRawPunches.has(direction)) continue;
    const pair = `${direction}:${userCheckTime}`;
    if (timeDirectionPairs.has(pair)) continue;
    const recordId = text(candidate.钉钉记录ID);
    punches.set(recordId ? `record:${recordId}` : `time:${pair}`, {
      direction,
      userCheckTime,
      ...(recordId ? { recordId } : {}),
      ...(text(candidate.无效原因)
        ? { invalidReason: text(candidate.无效原因) }
        : {}),
    });
    timeDirectionPairs.add(pair);
  }
  return [...punches.values()].sort(
    (left, right) =>
      left.userCheckTime - right.userCheckTime ||
      left.direction.localeCompare(right.direction),
  );
}

function directionStatus(
  candidates: readonly Record<string, unknown>[],
  checks: readonly Record<string, any>[],
  punches: readonly AttendanceRawPunch[],
  direction: 'OnDuty' | 'OffDuty',
): string {
  const matchingChecks = checks.filter(
    (check) => check?.expectation?.direction === direction,
  );
  const matchingPunches = punches.filter(
    (punch) => punch.direction === direction,
  );
  const validPunches = matchingPunches.filter((punch) => !punch.invalidReason);
  if (
    matchingChecks.length === 1 &&
    timestamp(matchingChecks[0].userCheckTime) <= 0 &&
    matchingPunches.length > 0
  ) {
    if (validPunches.length === 0) return '考勤异常';
    const actual =
      direction === 'OnDuty'
        ? Math.min(...validPunches.map((punch) => punch.userCheckTime))
        : Math.max(...validPunches.map((punch) => punch.userCheckTime));
    return reconcileDirectionStatus({
      actual,
      direction,
      expected: timestamp(matchingChecks[0]?.expectation?.expectedAt),
      invalidReason: '',
      status: statusLabel(matchingChecks[0].timeResult),
    });
  }
  if (matchingChecks.length) {
    return overallStatus(
      ...matchingChecks.map((check) =>
        reconcileDirectionStatus({
          actual: timestamp(check.userCheckTime),
          direction,
          expected: timestamp(check?.expectation?.expectedAt),
          invalidReason: text(
            check.invalidReason ??
              check.invalidRecordMsg ??
              check.invalid_reason,
          ),
          status: statusLabel(check.timeResult),
        }),
      ),
    );
  }
  const statuses = candidates.flatMap((candidate) =>
    normalizeDirection(candidate.打卡类型) === direction
      ? [
          {
            actual: timestamp(candidate.实际打卡时间),
            status: reconcileDirectionStatus({
              actual: timestamp(candidate.实际打卡时间),
              direction,
              expected: timestamp(candidate.应打卡时间),
              invalidReason: text(candidate.无效原因),
              status: text(candidate.时间状态),
            }),
          },
        ]
      : [],
  );
  const withActual = statuses.filter(
    (item) => item.actual > 0 && item.status !== '未打卡',
  );
  const selectedStatuses = withActual.length ? withActual : statuses;
  return selectedStatuses.length
    ? overallStatus(...selectedStatuses.map((item) => item.status))
    : '';
}

function reconcileDirectionStatus(input: {
  actual: number;
  direction: 'OnDuty' | 'OffDuty';
  expected: number;
  invalidReason: string;
  status: string;
}): string {
  const status = statusLabel(input.status);
  if (
    input.actual <= 0 ||
    input.invalidReason ||
    (status !== '未打卡' && status !== '旷工' && status !== '')
  ) {
    return status;
  }
  if (input.expected <= 0) return '正常';
  if (input.direction === 'OnDuty') {
    return input.actual <= input.expected ? '正常' : '迟到';
  }
  return input.actual >= input.expected ? '正常' : '早退';
}

function overallStatus(...values: string[]): string {
  const statuses = new Set(values.map((value) => value.trim()).filter(Boolean));
  for (const status of ['未打卡', '旷工', '迟到', '早退', '考勤异常']) {
    if (statuses.has(status)) return status;
  }
  return statuses.has('正常') ? '正常' : values.find(Boolean) || '';
}

function statusLabel(value: unknown): string {
  const status = String(value || '').trim();
  if (status === 'Normal' || status === '正常') return '正常';
  if (status === 'NotSigned' || status === '未打卡') return '未打卡';
  if (status === 'Absenteeism' || status === '旷工') return '旷工';
  if (status === 'Late' || status === 'SeriousLate' || status === '迟到')
    return '迟到';
  if (status === 'EarlyLeave' || status === 'Early' || status === '早退')
    return '早退';
  return status;
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

const ATTENDANCE_TEXT_FIELDS = new Set([
  '文本',
  '记录唯一键',
  '姓名',
  '钉钉员工ID',
  '打卡地址',
  '外勤备注',
  '无效原因',
  '设备ID',
  '钉钉记录ID',
  '原始记录JSON',
  '补卡审批实例ID',
  '补卡理由',
  '补卡异常说明',
  '全部打卡时间',
]);

const ATTENDANCE_SELECT_FIELDS = new Set([
  '记录类型',
  '打卡类型',
  '时间状态',
  '位置状态',
  '是否合法',
  '数据来源',
  '同步状态',
  '补卡状态',
  '班次',
  '上班状态',
  '下班状态',
]);

const ATTENDANCE_DATE_FIELDS = new Set([
  '工作日期',
  '应打卡时间',
  '实际打卡时间',
  '同步时间',
  '上班打卡时间',
  '下班打卡时间',
]);

const ATTENDANCE_NUMBER_FIELDS = new Set(['经度', '纬度', '打卡次数']);

const ATTENDANCE_CLEARABLE_FIELDS = new Set([
  '上班打卡时间',
  '下班打卡时间',
  '上班状态',
  '下班状态',
  '全部打卡时间',
  '补卡异常说明',
]);

function normalizeAttendanceWriteFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') {
      if (ATTENDANCE_CLEARABLE_FIELDS.has(name)) normalized[name] = null;
      continue;
    }
    if (ATTENDANCE_TEXT_FIELDS.has(name)) {
      normalized[name] =
        typeof value === 'string' ? value : extractDisplayText(value, '');
      continue;
    }
    if (ATTENDANCE_SELECT_FIELDS.has(name)) {
      normalized[name] = text(value);
      continue;
    }
    if (ATTENDANCE_DATE_FIELDS.has(name)) {
      normalized[name] = timestamp(value) || undefined;
      continue;
    }
    if (ATTENDANCE_NUMBER_FIELDS.has(name)) {
      const numeric =
        typeof value === 'number'
          ? value
          : Number(extractDisplayText(value, ''));
      normalized[name] = Number.isFinite(numeric) ? numeric : undefined;
      continue;
    }
    if (name === '补卡举证材料') {
      const tokens = evidenceTokens(value);
      normalized[name] = tokens.length
        ? tokens.map((fileToken) => ({ file_token: fileToken }))
        : undefined;
    }
  }
  return normalized;
}

function normalizeDirection(value: unknown): 'OnDuty' | 'OffDuty' | undefined {
  const direction = text(value);
  if (direction === 'OnDuty' || direction === '上班') return 'OnDuty';
  if (direction === 'OffDuty' || direction === '下班') return 'OffDuty';
  return undefined;
}

function isAttendanceArchiveRow(fields: Record<string, unknown>): boolean {
  return ['考勤结果', '打卡明细'].includes(text(fields.记录类型));
}

function formatShanghaiTime(value: number): string {
  return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(11, 19);
}

function resolveAttendanceShiftIdentity(
  fields: Record<string, unknown>,
): AttendanceShiftIdentity | undefined {
  if (!['考勤结果', '打卡明细'].includes(text(fields.记录类型)))
    return undefined;
  const userId = text(fields.钉钉员工ID);
  const date = workDate(fields.工作日期);
  if (!userId || !date) return undefined;
  const original = parseOriginal(fields.原始记录JSON);
  const hints = new Set<string>();
  const shiftHint = parseAttendanceShiftHint(original.attendanceShiftKey);
  if (shiftHint) hints.add(`${shiftHint.buildingCode}:${shiftHint.shiftCode}`);
  const expectationKeys = [
    original.expectationKey,
    ...(Array.isArray(original.attendanceChecks)
      ? original.attendanceChecks.map((check) => check?.expectation?.key)
      : []),
  ];
  for (const value of expectationKeys) {
    const hint = parseAttendanceExpectationKey(value);
    if (hint) hints.add(`${hint.buildingCode}:${hint.shiftCode}`);
  }
  if (hints.size !== 1) return undefined;
  const [buildingCode, shiftCode] = [...hints][0].split(':');
  const label =
    shiftCode === 'night'
      ? '夜班'
      : shiftCode === 'long_white'
        ? '长白班'
        : shiftCode === 'white'
          ? '白班'
          : text(fields.班次);
  const businessKey = `attendance-v4-${createHash('sha256')
    .update(JSON.stringify([userId, date, buildingCode, shiftCode]))
    .digest('hex')}`;
  return {
    businessKey,
    buildingCode,
    date,
    label,
    personDateKey: `${userId}:${date}`,
    shiftCode,
    userId,
  };
}

function parseAttendanceExpectationKey(value: unknown): {
  buildingCode: string;
  shiftCode: string;
} | null {
  const match =
    /^\d{4}-\d{2}-\d{2}:(building_[abcdeh]|station_110):(white|night|long_white):(OnDuty|OffDuty):.+$/u.exec(
      String(value || '').trim(),
    );
  return match ? { buildingCode: match[1], shiftCode: match[2] } : null;
}

function parseAttendanceShiftHint(value: unknown): {
  buildingCode: string;
  shiftCode: string;
} | null {
  const match =
    /^\d{4}-\d{2}-\d{2}:(building_[abcdeh]|station_110):(white|night|long_white)$/u.exec(
      String(value || '').trim(),
    );
  return match ? { buildingCode: match[1], shiftCode: match[2] } : null;
}

function attendancePersonDateKey(
  fields: Record<string, unknown>,
): string | undefined {
  const userId = text(fields.钉钉员工ID);
  const date = workDate(fields.工作日期);
  return userId && date ? `${userId}:${date}` : undefined;
}

function fallbackAttendanceBusinessKey(
  fields: Record<string, unknown>,
): string | undefined {
  const personDateKey = attendancePersonDateKey(fields);
  if (!personDateKey) return undefined;
  return `attendance-v4-${createHash('sha256')
    .update(JSON.stringify([personDateKey, 'legacy-unresolved-shift']))
    .digest('hex')}`;
}

function evidenceTokens(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item?.file_token === 'string' ? [item.file_token] : [],
      )
    : [];
}

function rank(fields: Record<string, unknown>): number {
  const validActual =
    timestamp(fields.实际打卡时间) > 0 &&
    text(fields.时间状态) !== '未打卡' &&
    !text(fields.无效原因);
  return (validActual ? 4 : 0) + (text(fields.记录类型) === '考勤结果' ? 2 : 0);
}

function parseOriginal(value: unknown): Record<string, unknown> {
  try {
    const raw =
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value.map((item) => item?.text || '').join('')
          : '';
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function timestamp(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const raw = text(value);
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : Date.parse(raw) || 0;
}

function workDate(value: unknown): string | undefined {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const epoch = timestamp(value);
  return epoch > 0
    ? new Date(epoch + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : undefined;
}
