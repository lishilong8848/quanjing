import type {
  SystemMonthlyReportDashboard,
  SystemMonthlyReportHistoryItem,
  SystemMonthlyReportMilestone,
  SystemMonthlyReportMonthlySnapshot,
  SystemMonthlyReportModuleKey,
  SystemMonthlyReportPerson,
  SystemMonthlyReportReviewOpinion,
  SystemMonthlyReportReviewRound,
  SystemMonthlyReportRoom,
  SystemMonthlyReportRoomStatus,
  SystemMonthlyReportScheduleItem,
  SystemMonthlyReportStandard,
  SystemMonthlyReportStep,
  SystemMonthlyReportStepKey,
  SystemMonthlyReportStage,
} from '../../../shared/system-monthly-report.interface';
import { getChinaWorkdayInfo } from '../../../shared/china-work-calendar';
import {
  getSystemMonthlyReportEditCutoff,
  isSystemMonthlyReportEditWindowOpen,
} from './system-monthly-report.rules';

export interface RawBitableRecord {
  record_id?: string;
  id?: string;
  last_modified_time?: number | string;
  fields?: Record<string, unknown>;
}

export interface SystemMonthlyReportFinalAttachmentSource {
  fileToken: string;
  name: string;
  size: number;
}

export interface SystemMonthlyReportFinalRecordSource {
  recordId: string;
  year: number;
  month: number;
  room: string;
  submittedAt: string;
  attachments: SystemMonthlyReportFinalAttachmentSource[];
  initialAttachmentCount: number;
  recheckAttachmentCount: number;
}

export interface SystemMonthlyReportReviewAttachmentSource extends SystemMonthlyReportFinalAttachmentSource {}

export interface SystemMonthlyReportReviewOpinionSource {
  opinion: SystemMonthlyReportReviewOpinion;
  attachments: SystemMonthlyReportReviewAttachmentSource[];
  sourceFieldName: '初审问题截图' | '复审问题截图';
}

export interface RawBitableField {
  field_id?: string;
  id?: string;
  field_name?: string;
  property?: unknown;
}

export interface SystemMonthlyReportSourceInput {
  now: Date;
  currentRecords: RawBitableRecord[];
  collectionRecords: RawBitableRecord[];
  scheduleRecords: RawBitableRecord[];
  personnelRecords?: RawBitableRecord[];
  organizationPeople?: SystemMonthlyReportOrganizationPerson[];
  standardRecords: RawBitableRecord[];
  currentFields: RawBitableField[];
  scheduleFields: RawBitableField[];
  sourceUpdatedAt?: string;
  stale?: boolean;
}

export interface SystemMonthlyReportOrganizationPerson {
  openId: string;
  name: string;
  rooms: string[];
}

type OptionMaps = Record<string, Map<string, string>>;

const STATUS_LABELS: Record<SystemMonthlyReportRoomStatus, string> = {
  initial_pending: '待月报提交',
  initial_review: '初审中',
  recheck_pending: '待复审月报提交',
  recheck_review: '复审中',
  final_pending: '待终版月报提交',
  completed: '已完成',
};

const MILESTONE_LABELS: Record<SystemMonthlyReportStepKey, string> = {
  initial_submit: '月报提交',
  initial_review: '初审完成',
  recheck_submit: '复审月报提交',
  recheck_review: '复审完成',
  final_submit: '终版月报提交',
};

const MILESTONE_KEYS = Object.keys(
  MILESTONE_LABELS,
) as SystemMonthlyReportStepKey[];

type RoomStageProgress = { completed: boolean; completedAt: string | null };
type RoomProgress = Record<SystemMonthlyReportStepKey, RoomStageProgress>;
type PeriodRoomProgress = Map<string, Map<string, RoomProgress>>;

const REVIEW_MODULE_FIELDS: Record<
  SystemMonthlyReportModuleKey,
  { label: string; description: string }
> = {
  event: { label: '事件管理', description: '事件模块' },
  change: { label: '变更管理', description: '变更模块' },
  maintenance: { label: '维护管理', description: '维护模块' },
  drill: { label: '演练管理', description: '演练模块' },
  other: { label: '其他问题', description: '其他问题项' },
};

const ACTIVE_STATUS_BY_STEP: Record<
  SystemMonthlyReportStepKey,
  SystemMonthlyReportRoomStatus
> = {
  initial_submit: 'initial_pending',
  initial_review: 'initial_review',
  recheck_submit: 'recheck_pending',
  recheck_review: 'recheck_review',
  final_submit: 'final_pending',
};

const STANDARD_KEYS: Record<
  string,
  SystemMonthlyReportStandard['key'] | undefined
> = {
  事件管理: 'event',
  变更管理: 'change',
  维护管理: 'maintenance',
  演练管理: 'drill',
  风险管理: 'risk',
};

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const DAY_MS = 24 * 60 * 60 * 1000;

export function buildBitableOptionMaps(
  fields: readonly RawBitableField[],
): OptionMaps {
  const result: OptionMaps = {};
  for (const field of fields) {
    const name = clean(field.field_name);
    if (!name) continue;
    const options = findOptions(field.property);
    result[name] = new Map(
      options
        .map((option) => [clean(option.id), clean(option.name)] as const)
        .filter(([id, optionName]) => id && optionName),
    );
  }
  return result;
}

export function normalizeBitableDate(value: unknown): string | null {
  const date = parseBitableDate(value);
  if (!date) return null;
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function mapSystemMonthlyReportSources(
  input: SystemMonthlyReportSourceInput,
): SystemMonthlyReportDashboard {
  const currentOptions = buildBitableOptionMaps(input.currentFields);
  const scheduleOptions = buildBitableOptionMaps(input.scheduleFields);
  const calendarPeriod = shanghaiDateParts(input.now);
  const firstRoomRecord = input.currentRecords.find((record) =>
    clean(fieldText(record, '机房', currentOptions)),
  );
  const sourceReportMonth = clampMonth(
    numberFromText(
      fieldText(firstRoomRecord, '月报月份', currentOptions),
      calendarPeriod.month,
    ),
  );
  const reminderDate = normalizeBitableDate(
    getField(firstRoomRecord, '月报提醒日期'),
  );
  const reminderYear = reminderDate
    ? Number(reminderDate.slice(0, 4))
    : input.now.getFullYear();
  const reminderMonth = reminderDate
    ? Number(reminderDate.slice(5, 7))
    : input.now.getMonth() + 1;
  const sourceReportYear =
    sourceReportMonth === 12 && reminderMonth === 1
      ? reminderYear - 1
      : reminderYear;
  const reportPeriod =
    calendarPeriod.day >= 15
      ? { year: calendarPeriod.year, month: calendarPeriod.month }
      : { year: sourceReportYear, month: sourceReportMonth };
  const reportYear = reportPeriod.year;
  const reportMonth = reportPeriod.month;
  const useCurrentRecordProgress =
    sourceReportYear === reportYear && sourceReportMonth === reportMonth;
  const milestones = buildSystemMonthlyReportWorkdayMilestones(
    reportYear,
    reportMonth,
  );
  const personnelByRoom = mapPersonnelMatrix(input.personnelRecords || []);
  const mappedRooms = input.currentRecords
    .map((record) =>
      mapRoom(
        record,
        currentOptions,
        milestones,
        personnelByRoom,
        useCurrentRecordProgress,
      ),
    )
    .filter((room): room is SystemMonthlyReportRoom => Boolean(room));
  const history = mapHistory(input.collectionRecords);
  const reviewOpinions = mapLatestReviewOpinionRecords(
    input.collectionRecords,
  ).map((item) => item.opinion);
  const collectionProgress = mapCollectionProgress(input.collectionRecords);
  const currentPeriodKey = `${reportYear}-${String(reportMonth).padStart(2, '0')}`;
  const currentProgress = collectionProgress.get(currentPeriodKey);
  const finalSubmittedAtByRoom = new Map(
    history
      .filter((item) => item.year === reportYear && item.month === reportMonth)
      .map((item) => [item.room, item.finalSubmittedAt] as const),
  );
  const rooms = mappedRooms.map((room) =>
    reconcileRoomProgress(
      room,
      currentProgress?.get(room.room),
      finalSubmittedAtByRoom.get(room.room) || null,
    ),
  );
  const schedule = mapSchedule(
    input.scheduleRecords,
    scheduleOptions,
    reportYear,
    reportMonth,
    input.organizationPeople || [],
  );
  const standards = mapStandards(input.standardRecords);
  const monthlySnapshots = mapMonthlySnapshots(
    collectionProgress,
    reportYear,
    reportMonth,
    rooms,
  );
  const warnings: string[] = [];
  if (milestones.some((item) => !item.calendarSupported)) {
    warnings.push(
      `${reportMonth === 12 ? reportYear + 1 : reportYear} 年工作日日历尚未就绪，五阶段截止日暂不展示。`,
    );
  }

  const nowDate = formatDate(input.now);
  return {
    generatedAt: input.now.toISOString(),
    sourceUpdatedAt: input.sourceUpdatedAt || input.now.toISOString(),
    stale: Boolean(input.stale),
    period: {
      year: reportYear,
      month: reportMonth,
      label: `${reportYear}年${reportMonth}月体系月报`,
      reminderDate,
      initialDueDate:
        milestones.find((step) => step.key === 'initial_submit')?.date || null,
      recheckDueDate:
        milestones.find((step) => step.key === 'recheck_submit')?.date || null,
      finalDueDate:
        milestones.find((step) => step.key === 'final_submit')?.date || null,
      editable: isSystemMonthlyReportEditWindowOpen(
        reportYear,
        reportMonth,
        input.now,
      ),
      editableUntil: getSystemMonthlyReportEditCutoff(
        reportYear,
        reportMonth,
      ).toISOString(),
      calendarSupported: milestones.every((item) => item.calendarSupported),
      milestones,
    },
    summary: {
      totalRooms: rooms.length,
      completedRooms: rooms.filter((room) => room.status === 'completed')
        .length,
      inReviewRooms: rooms.filter(
        (room) =>
          room.status === 'initial_review' || room.status === 'recheck_review',
      ).length,
      pendingSubmissionRooms: rooms.filter((room) =>
        ['initial_pending', 'recheck_pending', 'final_pending'].includes(
          room.status,
        ),
      ).length,
      overdueRooms: rooms.filter((room) => {
        const current = room.steps.find((step) => step.state === 'current');
        return Boolean(current?.date && current.date < nowDate);
      }).length,
    },
    rooms,
    schedule,
    standards,
    history,
    monthlySnapshots,
    reviewOpinions,
    warnings,
  };
}

export function findSystemMonthlyReportSubmissionRecordIds(
  records: RawBitableRecord[],
  target: {
    room: string;
    reportYear: number;
    reportMonth: number;
    stage: SystemMonthlyReportStage;
  },
): string[] {
  const fieldName: Record<SystemMonthlyReportStage, string> = {
    initial: '初版月报',
    recheck: '复审月报',
    final: '终版月报',
  };
  return records
    .flatMap((record) => {
      const recordId = clean(record.record_id || record.id);
      const room = fieldText(record, '机房', {});
      const submittedAt = normalizeBitableDateTime(
        getField(record, '创建时间'),
      );
      const month = clampMonth(
        numberFromText(fieldText(record, '月报月份', {}), 0),
      );
      if (
        !recordId ||
        room !== target.room.trim() ||
        !submittedAt ||
        month !== target.reportMonth ||
        reportYearForSubmission(submittedAt, month) !== target.reportYear ||
        !attachmentTokens(getField(record, fieldName[target.stage])).length
      ) {
        return [];
      }
      return [recordId];
    })
    .sort();
}

export function buildSystemMonthlyReportWorkdayMilestones(
  reportYear: number,
  reportMonth: number,
): SystemMonthlyReportMilestone[] {
  const nextMonthIndex = reportMonth;
  const nextYear = reportYear + Math.floor(nextMonthIndex / 12);
  const nextMonth = nextMonthIndex % 12;
  const dates: string[] = [];
  let calendarSupported = true;

  for (let day = 1; day <= 40 && dates.length < 5; day += 1) {
    const current = new Date(Date.UTC(nextYear, nextMonth, day));
    if (current.getUTCMonth() !== nextMonth) break;
    const dateKey = formatUtcDate(current);
    const workday = getChinaWorkdayInfo(dateKey);
    if (!workday.supported) {
      calendarSupported = false;
      break;
    }
    if (workday.isWorkday) dates.push(dateKey);
  }

  return MILESTONE_KEYS.map((key, index) => ({
    key,
    label: MILESTONE_LABELS[key],
    workdayIndex: index + 1,
    date: calendarSupported ? dates[index] || null : null,
    calendarSupported: calendarSupported && Boolean(dates[index]),
  }));
}

function mapRoom(
  record: RawBitableRecord,
  options: OptionMaps,
  milestones: SystemMonthlyReportMilestone[],
  personnelByRoom: Map<
    string,
    {
      submitters: SystemMonthlyReportPerson[];
      leaders: SystemMonthlyReportPerson[];
    }
  >,
  useCurrentRecordProgress: boolean,
): SystemMonthlyReportRoom | null {
  const room = fieldText(record, '机房', options);
  const recordId = clean(record.record_id || record.id);
  if (!room || !recordId) return null;

  const progressDate = (fieldName: string) =>
    useCurrentRecordProgress
      ? normalizeBitableDateTime(getField(record, fieldName))
      : null;
  const initialSubmittedAt = progressDate('初版月报提交的最新时间');
  const initialReviewedAt = progressDate('初审意见提交的最新时间');
  const recheckSubmittedAt = progressDate('复审月报提交最新日期');
  const recheckReviewedAt = progressDate('复审意见提交最新日期');
  const finalSubmittedAt = progressDate('最终月报提交最新日期');
  const status = resolveRoomStatus({
    initialSubmittedAt,
    initialReviewedAt,
    recheckSubmittedAt,
    recheckReviewedAt,
    finalSubmittedAt,
  });
  const personnel = personnelByRoom.get(normalizeRoomLabel(room));
  const submitters = personnel?.submitters.length
    ? personnel.submitters
    : fieldPeople(record, '可提报人员');
  const leaders = personnel?.leaders.length
    ? personnel.leaders
    : fieldPeople(record, '十夫长');
  const leader = leaders[0] || null;
  const initialReviewer = fieldPeople(record, '初审人员')[0] || null;
  const recheckReviewer = fieldPeople(record, '二次复核人员')[0] || null;
  const owner = resolveOwner(
    status,
    submitters[0] || leader,
    initialReviewer,
    recheckReviewer,
  );
  const milestoneDate = (key: SystemMonthlyReportStepKey) =>
    milestones.find((item) => item.key === key)?.date || null;
  const steps: SystemMonthlyReportStep[] = [
    step(
      'initial_submit',
      MILESTONE_LABELS.initial_submit,
      Boolean(initialSubmittedAt),
      initialSubmittedAt || milestoneDate('initial_submit'),
      status,
      'initial_pending',
    ),
    step(
      'initial_review',
      MILESTONE_LABELS.initial_review,
      Boolean(initialReviewedAt),
      initialReviewedAt || milestoneDate('initial_review'),
      status,
      'initial_review',
    ),
    step(
      'recheck_submit',
      MILESTONE_LABELS.recheck_submit,
      Boolean(recheckSubmittedAt),
      recheckSubmittedAt || milestoneDate('recheck_submit'),
      status,
      'recheck_pending',
    ),
    step(
      'recheck_review',
      MILESTONE_LABELS.recheck_review,
      Boolean(recheckReviewedAt),
      recheckReviewedAt || milestoneDate('recheck_review'),
      status,
      'recheck_review',
    ),
    step(
      'final_submit',
      MILESTONE_LABELS.final_submit,
      Boolean(finalSubmittedAt),
      finalSubmittedAt || milestoneDate('final_submit'),
      status,
      'final_pending',
    ),
  ];
  const latestAt =
    [
      initialSubmittedAt,
      initialReviewedAt,
      recheckSubmittedAt,
      recheckReviewedAt,
      finalSubmittedAt,
    ]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) || null;

  return {
    recordId,
    code: fieldText(record, '月报编码', options) || room,
    room,
    status,
    statusLabel: STATUS_LABELS[status],
    currentOwnerRole: owner.role,
    currentOwnerName: owner.person?.name || '待认领',
    latestAt,
    submitters,
    leaders,
    leader,
    initialReviewer,
    recheckReviewer,
    issueSummary: {
      initial: fieldText(record, '初审问题统计', options),
      recheck: fieldText(record, '复审问题统计', options),
    },
    steps,
  };
}

function shanghaiDateParts(value: Date): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(value);
  const numberPart = (type: 'year' | 'month' | 'day') =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: numberPart('year'),
    month: numberPart('month'),
    day: numberPart('day'),
  };
}

function mapSchedule(
  records: RawBitableRecord[],
  options: OptionMaps,
  year: number,
  month: number,
  organizationPeople: SystemMonthlyReportOrganizationPerson[],
): SystemMonthlyReportScheduleItem[] {
  return records
    .map((record): SystemMonthlyReportScheduleItem | null => {
      const itemYear = numberFromText(
        fieldText(record, '审核年份', options),
        0,
      );
      const itemMonth = numberFromText(
        fieldText(record, '审核月份', options),
        0,
      );
      const roundText = fieldText(record, '审核轮次', options);
      const reviewer = fieldPeople(record, '审核人')[0];
      const room = fieldText(record, '审核机房', options);
      const recordId = clean(record.record_id || record.id);
      if (
        itemYear !== year ||
        itemMonth !== month ||
        !reviewer ||
        !room ||
        !recordId ||
        (roundText !== '初审' && roundText !== '复审')
      ) {
        return null;
      }
      return {
        recordId,
        year: itemYear,
        month: itemMonth,
        round: roundText === '初审' ? 'initial' : 'recheck',
        room,
        reviewerRoom:
          resolveReviewerRoom(reviewer, organizationPeople) ||
          normalizeRoomLabel(fieldText(record, '审核人所属机房', options)),
        reviewer,
        reviewDate: normalizeBitableDate(getField(record, '审核日期')),
      };
    })
    .filter((item): item is SystemMonthlyReportScheduleItem => Boolean(item))
    .sort(
      (left, right) =>
        left.round.localeCompare(right.round) ||
        left.room.localeCompare(right.room, 'zh-CN'),
    );
}

function mapPersonnelMatrix(records: RawBitableRecord[]): Map<
  string,
  {
    submitters: SystemMonthlyReportPerson[];
    leaders: SystemMonthlyReportPerson[];
  }
> {
  const result = new Map<
    string,
    {
      submitters: SystemMonthlyReportPerson[];
      leaders: SystemMonthlyReportPerson[];
    }
  >();
  for (const record of records) {
    const room = normalizeRoomLabel(fieldText(record, '机房', {}));
    if (!room || room === '测试') continue;
    const current = result.get(room) || { submitters: [], leaders: [] };
    current.submitters = mergePeople(
      current.submitters,
      fieldPeople(record, '负责人'),
    );
    current.leaders = mergePeople(
      current.leaders,
      fieldPeople(record, '十夫长'),
    );
    result.set(room, current);
  }
  return result;
}

function resolveReviewerRoom(
  reviewer: SystemMonthlyReportPerson,
  organizationPeople: SystemMonthlyReportOrganizationPerson[],
): string {
  const byOpenId = reviewer.openId
    ? organizationPeople.find((person) => person.openId === reviewer.openId)
    : undefined;
  const sameName = organizationPeople.filter(
    (person) => person.name === reviewer.name,
  );
  const matched = byOpenId || (sameName.length === 1 ? sameName[0] : undefined);
  return matched?.rooms.map(normalizeRoomLabel).find(Boolean) || '';
}

function mergePeople(
  left: SystemMonthlyReportPerson[],
  right: SystemMonthlyReportPerson[],
): SystemMonthlyReportPerson[] {
  const people = new Map<string, SystemMonthlyReportPerson>();
  for (const person of [...left, ...right]) {
    const key = person.openId || person.name;
    if (key && !people.has(key)) people.set(key, person);
  }
  return Array.from(people.values());
}

function normalizeRoomLabel(value: unknown): string {
  const normalized = clean(value)
    .replace(/\s+/gu, '')
    .replace(/[－—–]/gu, '-');
  if (!normalized) return '';
  const nantong = /^(?:南通[-]?)?([A-E])(?:楼)?$/iu.exec(normalized);
  if (nantong) return `南通-${nantong[1].toUpperCase()}`;
  return normalized;
}

function mapStandards(
  records: RawBitableRecord[],
): SystemMonthlyReportStandard[] {
  return records
    .map((record): SystemMonthlyReportStandard | null => {
      const module = fieldText(record, '板块', {});
      const key = STANDARD_KEYS[module];
      const recordId = clean(record.record_id || record.id);
      if (!key || !recordId) return null;
      return {
        recordId,
        key,
        module,
        weight: numberValue(getField(record, '占比')),
        rule: fieldText(record, '评分细则', {}),
        regionalRule: fieldText(record, '区域补充评分细则', {}),
      };
    })
    .filter((item): item is SystemMonthlyReportStandard => Boolean(item));
}

function mapHistory(
  records: RawBitableRecord[],
): SystemMonthlyReportHistoryItem[] {
  return mapLatestFinalReportRecords(records).map((record) => ({
    recordId: record.recordId,
    year: record.year,
    month: record.month,
    room: record.room,
    createdAt: record.submittedAt,
    finalSubmittedAt: record.submittedAt,
    initialAttachmentCount: record.initialAttachmentCount,
    recheckAttachmentCount: record.recheckAttachmentCount,
    finalAttachmentCount: record.attachments.length,
    archiveStatus: 'pending',
    archivedAttachmentCount: 0,
    attachments: record.attachments.map((attachment, index) => ({
      id: `pending-${record.recordId}-${index + 1}`,
      name: attachment.name,
      size: attachment.size,
      status: 'pending',
      retryable: false,
      message: '等待归档到 COS',
    })),
  }));
}

export function mapLatestFinalReportRecords(
  records: RawBitableRecord[],
): SystemMonthlyReportFinalRecordSource[] {
  const latest = new Map<string, SystemMonthlyReportFinalRecordSource>();
  for (const record of records) {
    const room = fieldText(record, '机房', {});
    const recordId = clean(record.record_id || record.id);
    const submittedAt = normalizeBitableDateTime(getField(record, '创建时间'));
    const month = clampMonth(
      numberFromText(fieldText(record, '月报月份', {}), 0),
    );
    const attachments = attachmentMetadata(getField(record, '终版月报'));
    if (!room || !recordId || !submittedAt || !month || !attachments.length) {
      continue;
    }
    const year = reportYearForSubmission(submittedAt, month);
    const candidate: SystemMonthlyReportFinalRecordSource = {
      recordId,
      year,
      month,
      room,
      submittedAt,
      attachments,
      initialAttachmentCount: attachmentTokens(getField(record, '初版月报'))
        .length,
      recheckAttachmentCount: attachmentTokens(getField(record, '复审月报'))
        .length,
    };
    const key = `${year}-${String(month).padStart(2, '0')}\u001f${room}`;
    const previous = latest.get(key);
    if (
      !previous ||
      candidate.submittedAt > previous.submittedAt ||
      (candidate.submittedAt === previous.submittedAt &&
        candidate.recordId > previous.recordId)
    ) {
      latest.set(key, candidate);
    }
  }
  return Array.from(latest.values()).sort(
    (left, right) =>
      right.submittedAt.localeCompare(left.submittedAt) ||
      left.room.localeCompare(right.room, 'zh-CN'),
  );
}

export function mapLatestReviewOpinionRecords(
  records: RawBitableRecord[],
): SystemMonthlyReportReviewOpinionSource[] {
  const latest = new Map<string, SystemMonthlyReportReviewOpinionSource>();
  for (const record of records) {
    const room = fieldText(record, '机房', {});
    const recordId = clean(record.record_id || record.id);
    const submittedAt = normalizeBitableDateTime(getField(record, '创建时间'));
    const month = clampMonth(
      numberFromText(fieldText(record, '月报月份', {}), 0),
    );
    if (!room || !recordId || !submittedAt || !month) continue;
    const year = reportYearForSubmission(submittedAt, month);
    for (const round of ['initial', 'recheck'] as const) {
      const prefix = round === 'initial' ? '初审' : '复审';
      const confirmed =
        isAffirmative(getField(record, `${prefix}确认提交`)) ||
        (round === 'initial' && isAffirmative(getField(record, '初审审核')));
      if (!confirmed) continue;
      const summary = fieldText(record, `${prefix}意见`, {});
      const issues = (
        Object.entries(REVIEW_MODULE_FIELDS) as Array<
          [SystemMonthlyReportModuleKey, { label: string; description: string }]
        >
      ).flatMap(([key, definition]) => {
        const description = fieldText(
          record,
          `${prefix}：${definition.description}`,
          {},
        );
        return description
          ? [{ key, label: definition.label, description }]
          : [];
      });
      const attachments = attachmentMetadata(
        getField(record, `${prefix}问题截图`),
      );
      const sourceFieldName = `${prefix}问题截图` as
        | '初审问题截图'
        | '复审问题截图';
      const opinion: SystemMonthlyReportReviewOpinion = {
        recordId,
        year,
        month,
        room,
        round,
        reviewer: fieldPeople(record, '提交人')[0] || null,
        submittedAt,
        summary:
          summary ||
          (issues.length
            ? issues
                .map((item) => `${item.label}：${item.description}`)
                .join('\n')
            : '本轮审核未发现问题'),
        conclusion:
          issues.length ||
          attachments.length ||
          (summary && summary !== '本轮审核未发现问题')
            ? 'has_issues'
            : 'passed',
        issues,
        images: attachments.map((attachment, index) => ({
          id: `pending-${recordId}-${round}-${index + 1}`,
          name: attachment.name,
          size: attachment.size,
          status: 'pending',
          retryable: false,
          message: '等待归档到 COS',
        })),
      };
      const candidate: SystemMonthlyReportReviewOpinionSource = {
        opinion,
        attachments,
        sourceFieldName,
      };
      const key = `${year}-${String(month).padStart(2, '0')}\u001f${room}\u001f${round}`;
      const previous = latest.get(key);
      if (
        !previous ||
        submittedAt > previous.opinion.submittedAt ||
        (submittedAt === previous.opinion.submittedAt &&
          recordId > previous.opinion.recordId)
      ) {
        latest.set(key, candidate);
      }
    }
  }
  return Array.from(latest.values()).sort(
    (left, right) =>
      right.opinion.submittedAt.localeCompare(left.opinion.submittedAt) ||
      left.opinion.room.localeCompare(right.opinion.room, 'zh-CN') ||
      left.opinion.round.localeCompare(right.opinion.round),
  );
}

function mapMonthlySnapshots(
  collectionProgress: PeriodRoomProgress,
  currentYear: number,
  currentMonth: number,
  currentRooms: SystemMonthlyReportRoom[],
): SystemMonthlyReportMonthlySnapshot[] {
  const periods: PeriodRoomProgress = new Map(
    Array.from(collectionProgress.entries()).map(([periodKey, roomMap]) => [
      periodKey,
      new Map(roomMap),
    ]),
  );

  if (currentRooms.length) {
    const periodKey = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
    const roomMap = periods.get(periodKey) || new Map<string, RoomProgress>();
    for (const room of currentRooms) {
      roomMap.set(
        room.room,
        mergeRoomProgress(roomMap.get(room.room), roomProgressFromRoom(room)),
      );
    }
    periods.set(periodKey, roomMap);
  }

  return Array.from(periods.entries())
    .map(([periodKey, roomMap]) => {
      const [year, month] = periodKey.split('-').map(Number);
      const values = Array.from(roomMap.values());
      const stageCompletedRooms = Object.fromEntries(
        MILESTONE_KEYS.map((key) => [
          key,
          values.filter((progress) => progress[key].completed).length,
        ]),
      ) as Record<SystemMonthlyReportStepKey, number>;
      return {
        year,
        month,
        totalRooms: values.length,
        completedRooms: stageCompletedRooms.final_submit,
        stageCompletedRooms,
        rooms: Array.from(roomMap.entries())
          .map(([room, stages]) => ({ room, stages }))
          .sort((left, right) => left.room.localeCompare(right.room, 'zh-CN')),
        milestones: buildSystemMonthlyReportWorkdayMilestones(year, month),
      };
    })
    .sort((left, right) => right.year - left.year || right.month - left.month);
}

function mapCollectionProgress(
  records: RawBitableRecord[],
): PeriodRoomProgress {
  const periods: PeriodRoomProgress = new Map();
  for (const record of records) {
    const room = fieldText(record, '机房', {});
    const createdAt = normalizeBitableDateTime(getField(record, '创建时间'));
    const month = clampMonth(
      numberFromText(fieldText(record, '月报月份', {}), 0),
    );
    if (!room || !createdAt || !month) continue;
    const year = reportYearForSubmission(createdAt, month);
    const periodKey = `${year}-${String(month).padStart(2, '0')}`;
    const roomMap = periods.get(periodKey) || new Map<string, RoomProgress>();
    const stage = (completed: boolean): RoomStageProgress => ({
      completed,
      completedAt: completed ? createdAt : null,
    });
    const recordProgress: RoomProgress = {
      initial_submit: stage(
        attachmentTokens(getField(record, '初版月报')).length > 0,
      ),
      initial_review: stage(
        isAffirmative(getField(record, '初审确认提交')) ||
          isAffirmative(getField(record, '初审审核')),
      ),
      recheck_submit: stage(
        attachmentTokens(getField(record, '复审月报')).length > 0,
      ),
      recheck_review: stage(isAffirmative(getField(record, '复审确认提交'))),
      final_submit: stage(
        attachmentTokens(getField(record, '终版月报')).length > 0,
      ),
    };
    roomMap.set(room, mergeRoomProgress(roomMap.get(room), recordProgress));
    periods.set(periodKey, roomMap);
  }
  return periods;
}

function reconcileRoomProgress(
  room: SystemMonthlyReportRoom,
  collectionProgress: RoomProgress | undefined,
  finalSubmittedAt: string | null,
): SystemMonthlyReportRoom {
  const progress = mergeRoomProgress(
    collectionProgress,
    roomProgressFromRoom(room),
  );
  const status = resolveRoomStatusFromProgress(progress);
  const owner = resolveOwner(
    status,
    room.submitters[0] || room.leader,
    room.initialReviewer,
    room.recheckReviewer,
  );
  const latestAt =
    [room.latestAt, finalSubmittedAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) || null;

  return {
    ...room,
    status,
    statusLabel: STATUS_LABELS[status],
    currentOwnerRole: owner.role,
    currentOwnerName: owner.person?.name || '待认领',
    latestAt,
    steps: room.steps.map((item) =>
      step(
        item.key,
        item.label,
        progress[item.key].completed,
        item.key === 'final_submit' && finalSubmittedAt
          ? finalSubmittedAt
          : item.date,
        status,
        ACTIVE_STATUS_BY_STEP[item.key],
      ),
    ),
  };
}

function roomProgressFromRoom(room: SystemMonthlyReportRoom): RoomProgress {
  return Object.fromEntries(
    MILESTONE_KEYS.map((key) => [
      key,
      {
        completed:
          room.steps.find((item) => item.key === key)?.state === 'completed',
        completedAt: null,
      },
    ]),
  ) as RoomProgress;
}

function mergeRoomProgress(
  left: RoomProgress | undefined,
  right: RoomProgress,
): RoomProgress {
  return normalizeRoomProgress(
    Object.fromEntries(
      MILESTONE_KEYS.map((key) => {
        const candidates = [left?.[key].completedAt, right[key].completedAt]
          .filter((value): value is string => Boolean(value))
          .sort();
        return [
          key,
          {
            completed: Boolean(left?.[key].completed || right[key].completed),
            completedAt: candidates.at(-1) || null,
          },
        ];
      }),
    ) as RoomProgress,
  );
}

function normalizeRoomProgress(progress: RoomProgress): RoomProgress {
  const normalized = { ...progress };
  let laterStageCompleted = false;
  for (let index = MILESTONE_KEYS.length - 1; index >= 0; index -= 1) {
    const key = MILESTONE_KEYS[index];
    laterStageCompleted ||= normalized[key].completed;
    normalized[key] = {
      ...normalized[key],
      completed: laterStageCompleted,
    };
  }
  return normalized;
}

function resolveRoomStatusFromProgress(
  progress: RoomProgress,
): SystemMonthlyReportRoomStatus {
  if (progress.final_submit.completed) return 'completed';
  if (progress.recheck_review.completed) return 'final_pending';
  if (progress.recheck_submit.completed) return 'recheck_review';
  if (progress.initial_review.completed) return 'recheck_pending';
  if (progress.initial_submit.completed) return 'initial_review';
  return 'initial_pending';
}

function resolveRoomStatus(values: {
  initialSubmittedAt: string | null;
  initialReviewedAt: string | null;
  recheckSubmittedAt: string | null;
  recheckReviewedAt: string | null;
  finalSubmittedAt: string | null;
}): SystemMonthlyReportRoomStatus {
  if (values.finalSubmittedAt) return 'completed';
  if (values.recheckReviewedAt) return 'final_pending';
  if (values.recheckSubmittedAt) return 'recheck_review';
  if (values.initialReviewedAt) return 'recheck_pending';
  if (values.initialSubmittedAt) return 'initial_review';
  return 'initial_pending';
}

function resolveOwner(
  status: SystemMonthlyReportRoomStatus,
  submitter: SystemMonthlyReportPerson | null | undefined,
  initialReviewer: SystemMonthlyReportPerson | null,
  recheckReviewer: SystemMonthlyReportPerson | null,
): { role: string; person: SystemMonthlyReportPerson | null | undefined } {
  if (status === 'initial_review') {
    return { role: '初审人', person: initialReviewer };
  }
  if (status === 'recheck_review') {
    return { role: '复审人', person: recheckReviewer };
  }
  if (status === 'completed') {
    return { role: '归档人', person: submitter };
  }
  return { role: '可提报人员', person: submitter };
}

function step(
  key: SystemMonthlyReportStep['key'],
  label: string,
  completed: boolean,
  date: string | null,
  status: SystemMonthlyReportRoomStatus,
  activeStatus: SystemMonthlyReportRoomStatus,
): SystemMonthlyReportStep {
  return {
    key,
    label,
    state: completed
      ? 'completed'
      : status === activeStatus
        ? 'current'
        : 'pending',
    date: date ? date.slice(0, 10) : null,
  };
}

function fieldText(
  record: RawBitableRecord | undefined,
  fieldName: string,
  options: OptionMaps,
): string {
  return extractStrings(getField(record, fieldName), options[fieldName]).join(
    '、',
  );
}

function fieldPeople(
  record: RawBitableRecord | undefined,
  fieldName: string,
): SystemMonthlyReportPerson[] {
  const result: SystemMonthlyReportPerson[] = [];
  collectPeople(getField(record, fieldName), result);
  const deduped = new Map<string, SystemMonthlyReportPerson>();
  for (const person of result) {
    const key = person.openId || person.name;
    if (key && !deduped.has(key)) deduped.set(key, person);
  }
  return Array.from(deduped.values());
}

function getField(
  record: RawBitableRecord | undefined,
  fieldName: string,
): unknown {
  return record?.fields?.[fieldName];
}

function findOptions(property: unknown): Array<Record<string, unknown>> {
  if (!isRecord(property)) return [];
  if (Array.isArray(property.options)) {
    return property.options.filter(isRecord);
  }
  const type = isRecord(property.type) ? property.type : null;
  const uiProperty =
    type && isRecord(type.ui_property) ? type.ui_property : null;
  return Array.isArray(uiProperty?.options)
    ? uiProperty.options.filter(isRecord)
    : [];
}

function extractStrings(
  value: unknown,
  options?: Map<string, string>,
): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const text = clean(value);
    return text ? [options?.get(text) || text] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractStrings(item, options));
  }
  if (!isRecord(value)) return [];
  if (Array.isArray(value.users)) {
    return value.users.flatMap((user) => extractStrings(user, options));
  }
  for (const key of ['name', 'text', 'value']) {
    if (value[key] !== undefined) return extractStrings(value[key], options);
  }
  return [];
}

function collectPeople(
  value: unknown,
  result: SystemMonthlyReportPerson[],
): void {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPeople(item, result));
    return;
  }
  if (!isRecord(value)) return;
  if (Array.isArray(value.users)) {
    value.users.forEach((item) => collectPeople(item, result));
    return;
  }
  if (Array.isArray(value.value)) {
    value.value.forEach((item) => collectPeople(item, result));
  }
  const name = clean(value.name || value.en_name || value.text);
  const openId = clean(value.id || value.open_id || value.user_id);
  if (name) result.push({ openId, name });
}

function normalizeBitableDateTime(value: unknown): string | null {
  const date = parseBitableDate(value);
  return date ? date.toISOString() : null;
}

function parseBitableDate(value: unknown): Date | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseBitableDate(item);
      if (parsed) return parsed;
    }
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 20_000 && value <= 80_000) {
      return new Date(EXCEL_EPOCH_UTC + value * DAY_MS);
    }
    const milliseconds =
      Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const text = clean(value);
    if (!text) return null;
    if (/^\d+(?:\.\d+)?$/.test(text)) return parseBitableDate(Number(text));
    const date = new Date(text.replace(/\//g, '-'));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (isRecord(value)) {
    for (const key of ['timestamp', 'date', 'value', 'text']) {
      const parsed = parseBitableDate(value[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function attachmentTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      isRecord(item)
        ? clean(item.file_token || item.fileToken || item.token || item.name)
        : '',
    )
    .filter(Boolean);
}

function attachmentMetadata(
  value: unknown,
): SystemMonthlyReportFinalAttachmentSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const fileToken = clean(item.file_token || item.fileToken || item.token);
    if (!fileToken) return [];
    const name = clean(item.name) || `终版月报-${index + 1}`;
    const size = Number(item.size);
    return [
      {
        fileToken,
        name: name.slice(0, 200),
        size: Number.isSafeInteger(size) && size > 0 ? size : 0,
      },
    ];
  });
}

function reportYearForSubmission(submittedAt: string, month: number): number {
  const createdYear = Number(submittedAt.slice(0, 4));
  const createdMonth = Number(submittedAt.slice(5, 7));
  return month > createdMonth ? createdYear - 1 : createdYear;
}

function isAffirmative(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return extractStrings(value).some((item) =>
    ['是', 'true', '1'].includes(item.toLowerCase()),
  );
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(extractStrings(value)[0]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberFromText(value: string, fallback: number): number {
  const match = /\d+/.exec(value);
  const parsed = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampMonth(value: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 12 ? value : 0;
}

function formatDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatUtcDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
