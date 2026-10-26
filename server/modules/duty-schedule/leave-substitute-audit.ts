export interface BitableLikeRecord {
  id?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
}

export interface LeaveSubstituteRepairPlanOptions {
  scheduleRecords: BitableLikeRecord[];
  leaveRecords: BitableLikeRecord[];
  scanStartDate: string;
  scanEndDate: string;
  year?: number;
}

export interface InferActualSubstituteStaffOptions {
  plannedStaff: string[];
  leaveStaff: string[];
  actualStaff: string[];
}

export interface LeaveSubstituteMismatch {
  scheduleRecordId: string;
  dutyCode: string;
  date: string;
  building: string;
  team: string;
  shift: string;
  leaveStaff: string[];
  plannedStaff: string[];
  actualStaff: string[];
  currentSubstitutes: string[];
  missingSubstitutes: string[];
  inferredActualSubstitutes: string[];
}

export interface LeaveSubstituteRepairItem {
  scheduleRecordId: string;
  leaveRecordId: string;
  dutyCode: string;
  leaveCode: string;
  date: string;
  building: string;
  team: string;
  shift: string;
  leaveName: string;
  currentSubstitute: string;
  suggestedSubstitute: string;
  patch: {
    fld7noByKE: true;
    fldpUkeEzS: string;
  };
}

export interface LeaveSubstituteManualReviewItem extends LeaveSubstituteMismatch {
  leaveName: string;
  reason: string;
}

export interface LeaveSubstituteRepairPlan {
  scanStartDate: string;
  scanEndDate: string;
  year: number | null;
  checkedSchedules: number;
  mismatches: LeaveSubstituteMismatch[];
  repairs: LeaveSubstituteRepairItem[];
  manualReviews: LeaveSubstituteManualReviewItem[];
}

interface ScheduleAuditRow {
  recordId: string;
  dutyCode: string;
  date: string;
  building: string;
  team: string;
  shift: string;
  plannedStaff: string[];
  leaveStaff: string[];
  currentSubstitutes: string[];
  actualStaff: string[];
}

interface LeaveAuditRow {
  recordId: string;
  leaveCode: string;
  date: string;
  building: string;
  team: string;
  shift: string;
  leaveStaff: string[];
  needSubstitute: boolean;
  substituteStaff: string[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

const SCHEDULE_FIELDS = {
  dutyCode: ['fldITqhd37', '值班编码', '值班编号'],
  date: ['fldZSaDbGf', '排班日期', '日期', 'schedule_date', '排班日期（日期）'],
  building: ['fldnP4gXMn', 'fldUHstSKX', '机楼', '楼栋', '值守机楼'],
  team: ['fldE9Gwnk7', 'fld5x9advB', '班组', '班别'],
  shift: ['fldqPpOgW5', '班次', '值班班次'],
  plannedStaff: ['fldJi5bxBG', '人员（文本）', '人员文本', '人员'],
  leaveStaff: ['fld4xMPICY', '请假人员（请假表）', '请假人员'],
  currentSubstitutes: ['fldZnstUS3', '替班人员（请假表）', '替班人员', '替岗人员'],
  actualStaff: [
    '值班人员（实际）程序修改',
    '值班人员(实际)程序修改',
    '值班人员程序修改',
    'fldgeSx7S1',
    '值班人员（实际）',
    '值班人员(实际)',
  ],
};

const LEAVE_FIELDS = {
  leaveCode: ['fldCBykrmQ', '休假编号'],
  date: [
    'fldV79GRbE',
    '休假开始时间（辅助）',
    '开始时间（年月日）',
    'fldjXCAzJk',
    '休假开始时间',
  ],
  building: ['fldInfluwF', '机楼', '机楼 (有关联）'],
  team: ['fldQJiJPd0', '班组'],
  shift: ['fldcbi40pZ', '班次（有关联）', '班次'],
  leaveStaff: ['fldoiQwQuq', '休假人员（文本）', '休假人员'],
  needSubstitute: ['fld7noByKE', '是否需要替班（替班打√）'],
  substituteStaff: ['fldpUkeEzS', '替班人员（填姓名）'],
};

export function getShanghaiWeekRange(referenceDate = new Date()): {
  startDate: string;
  endDate: string;
} {
  const dateKey = formatShanghaiDateKey(referenceDate);
  const noon = new Date(`${dateKey}T12:00:00+08:00`);
  const day = noon.getUTCDay();
  const startOffset = day === 0 ? -6 : 1 - day;
  const endOffset = startOffset + 6;
  return {
    startDate: addDaysToDateKey(dateKey, startOffset),
    endDate: addDaysToDateKey(dateKey, endOffset),
  };
}

export function buildLeaveSubstituteRepairPlan(
  options: LeaveSubstituteRepairPlanOptions,
): LeaveSubstituteRepairPlan {
  const year = Number.isFinite(options.year) ? Number(options.year) : null;
  const leaveRows = options.leaveRecords
    .map(mapLeaveRecord)
    .filter((row): row is LeaveAuditRow => Boolean(row));
  const repairs: LeaveSubstituteRepairItem[] = [];
  const manualReviews: LeaveSubstituteManualReviewItem[] = [];
  const mismatches: LeaveSubstituteMismatch[] = [];
  const repairedLeaveRecordIds = new Set<string>();
  let checkedSchedules = 0;

  for (const row of options.scheduleRecords.map(mapScheduleRecord)) {
    if (!row) {
      continue;
    }
    if (!isDateKeyInRange(row.date, options.scanStartDate, options.scanEndDate)) {
      continue;
    }
    if (year !== null && !row.date.startsWith(`${year}-`)) {
      continue;
    }

    checkedSchedules += 1;
    if (row.actualStaff.length === 0) {
      continue;
    }

    const missingSubstitutes = row.currentSubstitutes.filter(
      (name) => !containsName(row.actualStaff, name),
    );
    const inferredActualSubstitutes = inferActualSubstitutes(row);
    const hasMismatchedSubstitutes =
      row.currentSubstitutes.length > 0 && missingSubstitutes.length > 0;
    const hasEmptySubstituteField =
      row.currentSubstitutes.length === 0 &&
      row.leaveStaff.length > 0 &&
      inferredActualSubstitutes.length > 0;
    if (!hasMismatchedSubstitutes && !hasEmptySubstituteField) {
      continue;
    }

    const mismatch: LeaveSubstituteMismatch = {
      scheduleRecordId: row.recordId,
      dutyCode: row.dutyCode,
      date: row.date,
      building: row.building,
      team: row.team,
      shift: row.shift,
      leaveStaff: row.leaveStaff,
      plannedStaff: row.plannedStaff,
      actualStaff: row.actualStaff,
      currentSubstitutes: row.currentSubstitutes,
      missingSubstitutes,
      inferredActualSubstitutes,
    };
    mismatches.push(mismatch);

    if (row.leaveStaff.length === 0) {
      manualReviews.push({
        ...mismatch,
        leaveName: '',
        reason: '排班记录缺少请假人员，无法定位请假表记录',
      });
      continue;
    }

    row.leaveStaff.forEach((leaveName, index) => {
      const currentSubstituteCandidate =
        row.currentSubstitutes[index] ||
        (row.currentSubstitutes.length > 0 ? missingSubstitutes[0] : '') ||
        '';
      const target = findMatchingLeaveRecord(
        leaveRows,
        row,
        leaveName,
        currentSubstituteCandidate,
      );
      const suggestedSubstitute = inferSubstituteForLeaveName(
        inferredActualSubstitutes,
        row.leaveStaff,
        leaveName,
        index,
      );

      if (!suggestedSubstitute) {
        manualReviews.push({
          ...mismatch,
          leaveName,
          reason: '无法从值班人员(ai实际)中推断实际替班人员',
        });
        return;
      }
      if (!target) {
        manualReviews.push({
          ...mismatch,
          leaveName,
          reason: '未找到匹配的请假表记录',
        });
        return;
      }
      if (repairedLeaveRecordIds.has(target.recordId)) {
        return;
      }

      const currentSubstitute =
        target.substituteStaff.join(' ') ||
        currentSubstituteCandidate;
      if (
        target.needSubstitute &&
        containsName(target.substituteStaff, suggestedSubstitute)
      ) {
        return;
      }

      repairedLeaveRecordIds.add(target.recordId);
      repairs.push({
        scheduleRecordId: row.recordId,
        leaveRecordId: target.recordId,
        dutyCode: row.dutyCode,
        leaveCode: target.leaveCode,
        date: row.date,
        building: row.building,
        team: row.team,
        shift: row.shift,
        leaveName,
        currentSubstitute,
        suggestedSubstitute,
        patch: {
          fld7noByKE: true,
          fldpUkeEzS: suggestedSubstitute,
        },
      });
    });
  }

  return {
    scanStartDate: options.scanStartDate,
    scanEndDate: options.scanEndDate,
    year,
    checkedSchedules,
    mismatches,
    repairs,
    manualReviews,
  };
}

function mapScheduleRecord(record: BitableLikeRecord): ScheduleAuditRow | null {
  const fields = record.fields || {};
  const recordId = getRecordId(record);
  const date = extractDateKey(pickField(fields, SCHEDULE_FIELDS.date));
  if (!recordId || !date) {
    return null;
  }

  return {
    recordId,
    dutyCode: extractText(pickField(fields, SCHEDULE_FIELDS.dutyCode)),
    date,
    building: extractText(pickField(fields, SCHEDULE_FIELDS.building)),
    team: extractText(pickField(fields, SCHEDULE_FIELDS.team)),
    shift: extractText(pickField(fields, SCHEDULE_FIELDS.shift)),
    plannedStaff: extractPersonNames(pickField(fields, SCHEDULE_FIELDS.plannedStaff)),
    leaveStaff: extractPersonNames(pickField(fields, SCHEDULE_FIELDS.leaveStaff)),
    currentSubstitutes: extractPersonNames(pickField(fields, SCHEDULE_FIELDS.currentSubstitutes)),
    actualStaff: extractPersonNames(pickField(fields, SCHEDULE_FIELDS.actualStaff)),
  };
}

function mapLeaveRecord(record: BitableLikeRecord): LeaveAuditRow | null {
  const fields = record.fields || {};
  const recordId = getRecordId(record);
  const date = extractDateKey(pickField(fields, LEAVE_FIELDS.date));
  if (!recordId || !date) {
    return null;
  }

  return {
    recordId,
    leaveCode: extractText(pickField(fields, LEAVE_FIELDS.leaveCode)),
    date,
    building: extractText(pickField(fields, LEAVE_FIELDS.building)),
    team: extractText(pickField(fields, LEAVE_FIELDS.team)),
    shift: extractText(pickField(fields, LEAVE_FIELDS.shift)),
    leaveStaff: extractPersonNames(pickField(fields, LEAVE_FIELDS.leaveStaff)),
    needSubstitute: extractBoolean(pickField(fields, LEAVE_FIELDS.needSubstitute)),
    substituteStaff: extractPersonNames(pickField(fields, LEAVE_FIELDS.substituteStaff)),
  };
}

export function inferActualSubstituteStaff({
  plannedStaff,
  leaveStaff,
  actualStaff,
}: InferActualSubstituteStaffOptions): string[] {
  const retainedPlannedStaff = plannedStaff.filter(
    (name) => !containsName(leaveStaff, name),
  );
  return actualStaff.filter(
    (name) => !containsName(retainedPlannedStaff, name) && !containsName(leaveStaff, name),
  );
}

export function inferTemporarySubstituteStaff(
  options: InferActualSubstituteStaffOptions,
): string[] {
  if (options.leaveStaff.length > 0) {
    return [];
  }
  return inferActualSubstituteStaff(options);
}

function inferActualSubstitutes(row: ScheduleAuditRow): string[] {
  return inferActualSubstituteStaff(row);
}

function inferSubstituteForLeaveName(
  inferredActualSubstitutes: string[],
  leaveStaff: string[],
  leaveName: string,
  leaveIndex: number,
): string {
  if (inferredActualSubstitutes.length === 0) {
    return '';
  }
  if (inferredActualSubstitutes.length === 1) {
    return inferredActualSubstitutes[0];
  }
  const directIndex = leaveStaff.findIndex(
    (name) => normalizeNameForCompare(name) === normalizeNameForCompare(leaveName),
  );
  return inferredActualSubstitutes[directIndex >= 0 ? directIndex : leaveIndex] || '';
}

function findMatchingLeaveRecord(
  leaveRows: LeaveAuditRow[],
  row: ScheduleAuditRow,
  leaveName: string,
  currentSubstitute: string,
): LeaveAuditRow | null {
  const candidates = leaveRows.filter(
    (leave) =>
      leave.date === row.date &&
      containsName(leave.leaveStaff, leaveName) &&
      normalizeShiftKey(leave.shift) === normalizeShiftKey(row.shift),
  );
  if (candidates.length === 0) {
    return null;
  }

  const sameScope = candidates.filter((leave) => {
    const buildingMatches =
      !row.building || !leave.building || normalizeScopeText(row.building) === normalizeScopeText(leave.building);
    const teamMatches =
      !row.team || !leave.team || normalizeScopeText(row.team) === normalizeScopeText(leave.team);
    return buildingMatches && teamMatches;
  });
  const scopedCandidates = sameScope.length > 0 ? sameScope : candidates;
  const currentSubstituteMatch = scopedCandidates.find((leave) =>
    currentSubstitute ? containsName(leave.substituteStaff, currentSubstitute) : false,
  );
  return currentSubstituteMatch || scopedCandidates[0] || null;
}

function extractPersonNames(field: unknown): string[] {
  return dedupe(
    extractValues(field)
      .flatMap((value) => value.split(/[、,，;；\s\r\n]+/))
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function extractText(field: unknown): string {
  return extractValues(field).join(' ').trim();
}

function extractValues(field: unknown): string[] {
  if (field === null || field === undefined) {
    return [];
  }
  if (Array.isArray(field)) {
    return dedupe(field.flatMap((item) => extractValues(item)));
  }
  if (typeof field === 'string') {
    const text = field.trim();
    return text ? [text] : [];
  }
  if (typeof field === 'number' || typeof field === 'boolean') {
    return [String(field)];
  }
  if (typeof field === 'object') {
    const obj = field as Record<string, unknown>;
    const directValues = ['name', 'text', 'title', 'display_value', 'value', 'date', 'timestamp']
      .flatMap((key) => extractValues(obj[key]));
    if (directValues.length > 0) {
      return dedupe(directValues);
    }
  }
  return [];
}

function extractBoolean(field: unknown): boolean {
  if (Array.isArray(field)) {
    return field.some((item) => extractBoolean(item));
  }
  if (typeof field === 'boolean') {
    return field;
  }
  if (typeof field === 'number') {
    return field !== 0;
  }
  if (typeof field === 'string') {
    return /^(true|1|yes|y|是|对|需要)$/i.test(field.trim());
  }
  return false;
}

function extractDateKey(field: unknown): string | null {
  if (field === null || field === undefined) {
    return null;
  }
  if (Array.isArray(field)) {
    for (const item of field) {
      const parsed = extractDateKey(item);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }
  if (typeof field === 'number' && Number.isFinite(field)) {
    if (field > 30_000 && field < 100_000) {
      return new Date(EXCEL_EPOCH_UTC + Math.floor(field) * MS_PER_DAY)
        .toISOString()
        .slice(0, 10);
    }
    if (field > 1_000_000_000_000) {
      return formatShanghaiDateKey(new Date(field));
    }
    if (field > 1_000_000_000) {
      return formatShanghaiDateKey(new Date(field * 1000));
    }
    return null;
  }
  if (typeof field === 'string') {
    const text = field.trim();
    if (!text) {
      return null;
    }
    if (/^\d+(\.\d+)?$/.test(text)) {
      return extractDateKey(Number(text));
    }
    const normalized = text.replace(/\//g, '-');
    const directMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (directMatch) {
      return [
        directMatch[1],
        directMatch[2].padStart(2, '0'),
        directMatch[3].padStart(2, '0'),
      ].join('-');
    }
    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? formatShanghaiDateKey(parsed) : null;
  }
  if (typeof field === 'object') {
    const obj = field as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'text', 'value']) {
      const parsed = extractDateKey(obj[key]);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function pickField(fields: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) {
      const value = fields[name];
      if (value !== null && value !== undefined && value !== '') {
        return value;
      }
    }
  }
  return undefined;
}

function getRecordId(record: BitableLikeRecord): string {
  return record.record_id || record.id || '';
}

function containsName(names: string[], name: string): boolean {
  const compareName = normalizeNameForCompare(name);
  if (!compareName) {
    return false;
  }
  return names.some((item) => normalizeNameForCompare(item) === compareName);
}

function normalizeNameForCompare(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

function normalizeScopeText(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

function normalizeShiftKey(value: string): string {
  const normalized = normalizeScopeText(value);
  if (normalized.includes('夜')) {
    return 'night';
  }
  if (normalized.includes('白')) {
    return 'white';
  }
  return normalized;
}

function isDateKeyInRange(dateKey: string, startDate: string, endDate: string): boolean {
  return dateKey >= startDate && dateKey <= endDate;
}

function formatShanghaiDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatShanghaiDateKey(date);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const key = normalizeNameForCompare(value);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(value);
  });
  return result;
}
