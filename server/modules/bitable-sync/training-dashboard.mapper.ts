import type {
  CampusTrainingDashboardResponse,
  TrainingMetricComparison,
  TrainingMetricKey,
  TrainingSummary,
} from '../../../shared/campus-training-dashboard.interface';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { mapTrainingDashboardDetails } from './training-dashboard.details';
import { TRAINING_ACTIVE_EMPLOYEE_TEXT_FIELD } from './training-dashboard.fields';

export interface TrainingDashboardSources {
  activeStats: BitableRecordItem[];
  activeScores: BitableRecordItem[];
  activePlans: BitableRecordItem[];
  newHireScores: BitableRecordItem[];
  newHireCourses: BitableRecordItem[];
  newHirePlans: BitableRecordItem[];
  sharingSessions: BitableRecordItem[];
  sharingScores: BitableRecordItem[];
  sharingInterests: BitableRecordItem[];
}

const BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼'] as const;
const METRIC_KEYS: TrainingMetricKey[] = [
  'annualCompletedCourses',
  'monthlyPlannedCourses',
  'monthlyParticipants',
  'monthlyNewHires',
  'historicalSharingSessions',
  'monthlyPlannedSharingSessions',
];
const DAY_MS = 24 * 60 * 60 * 1000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DEFAULT_TRAINING_PASS_SCORE = 80;
const MIN_BUSINESS_YEAR = 2000;
const MAX_BUSINESS_YEAR = 2100;
const HANDWRITTEN_DATE_PATTERN =
  /^((?:19|20)\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:日)?$/;

interface ActiveStat {
  year: string | null;
  month: string | null;
  building: string;
  required: number | null;
  planned: number | null;
  completed: number | null;
  people: number | null;
  people2026: number | null;
  target: number | null;
  trainingCompletionRate: number | null;
  assessmentPassRate: number | null;
  cumulative: number | null;
}

interface ActivePlan {
  month: string | null;
  building: string;
  course: string;
  completed: boolean;
}

interface ActiveValues {
  annualCompletedCourses: number;
  monthlyPlannedCourses: number;
  monthlyParticipants: number;
  progress: CampusTrainingDashboardResponse['progress'];
  participation: CampusTrainingDashboardResponse['participation'];
}

interface NewHirePerson {
  stableId: string | null;
  name: string;
  normalizedName: string;
  building: string;
  joinedAt: string | null;
  dueAt: string | null;
  requiredCourses: number;
  completedCourses: number;
  progress2026: number | null;
  finalScore: number | null;
  sourceIndex: number;
}

interface NewHireValues {
  monthlyNewHires: number;
  plans: CampusTrainingDashboardResponse['newHirePlans'];
}

interface NewHireCourseCandidate {
  stableId: string | null;
  name: string;
  normalizedName: string;
  course: string;
  week: string;
  category: string;
  completed: boolean;
}

interface SharingSessionRecord {
  topic: string;
  category: string;
  status: string;
  eventMonth: string;
  startTimestamp: number | null;
  endTimestamp: number | null;
  presenterIds: string[];
  presenterNames: string[];
  participants: number;
  hasMaterial: boolean;
  scheduled: boolean;
}

interface SharingValues {
  historicalSharingSessions: number;
  monthlyPlannedSharingSessions: number;
  overview: CampusTrainingDashboardResponse['sharing'];
}

export function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  return formatShanghaiDate(new Date(EXCEL_EPOCH_MS + serial * DAY_MS));
}

export function mapCampusTrainingDashboard(
  sources: TrainingDashboardSources,
  requestedMonth: string | undefined,
  syncedAt: string,
  passScore = DEFAULT_TRAINING_PASS_SCORE,
): CampusTrainingDashboardResponse {
  sources = {
    ...sources,
    activeScores: sources.activeScores.map(normalizeActiveScoreEmployee),
  };
  const stats = sources.activeStats.map(mapActiveStat);
  const plans = sources.activePlans.map(mapActivePlan);
  const newHirePeople = mapNewHirePeople(sources.newHireScores);
  const newHireMonths = unique(
    newHirePeople
      .map((person) => person.joinedAt?.slice(0, 7) || null)
      .filter((month): month is string => Boolean(month)),
  ).sort((left, right) => right.localeCompare(left));
  const syncedMonth =
    monthFromDate(syncedAt) || formatShanghaiMonth(new Date());
  const normalizedRequestedMonth = normalizeRequestedMonth(requestedMonth);
  const selectedMonth = normalizedRequestedMonth || syncedMonth;
  const statAndPlanMonths = unique(
    [
      ...stats.map((item) => item.month),
      ...plans.map((item) => item.month),
    ].filter((month): month is string => Boolean(month)),
  ).sort((left, right) => right.localeCompare(left));
  const scoreYearHint = selectedMonth.slice(0, 4);
  const scoreMonths = sources.activeScores
    .filter(isValidActiveScore)
    .map((record) => resolveScoreMonth(record, scoreYearHint))
    .filter((month): month is string => Boolean(month));
  const sharingYearHint = selectedMonth.slice(0, 4);
  const sharingSessions = mapSharingSessions(
    sources.sharingSessions,
    sharingYearHint,
  );
  const sharingMonths = unique(
    sharingSessions
      .filter((session) => session.status !== '已终止')
      .map((session) => session.eventMonth),
  );
  const dataMonths = unique([
    ...statAndPlanMonths,
    ...scoreMonths,
    ...newHireMonths,
    ...sharingMonths,
  ]).sort((left, right) => right.localeCompare(left));
  const month = selectedMonth;
  const availableMonths = unique([
    syncedMonth,
    ...(month <= syncedMonth ? [month] : []),
    ...dataMonths.filter((dataMonth) => dataMonth <= syncedMonth),
  ]).sort((left, right) => right.localeCompare(left));
  const active = computeActiveValues(sources, stats, plans, month);
  const newHire = computeNewHireValues(newHirePeople, month);
  const newHireCourses = mapNewHireCourses(
    sources.newHirePlans,
    sources.newHireCourses,
  );
  const sharing = computeSharingValues(
    sharingSessions,
    sources.sharingScores,
    sources.sharingInterests,
    month,
  );
  const summary: TrainingSummary = {
    annualCompletedCourses: active.annualCompletedCourses,
    monthlyPlannedCourses: active.monthlyPlannedCourses,
    monthlyParticipants: active.monthlyParticipants,
    monthlyNewHires: newHire.monthlyNewHires,
    historicalSharingSessions: sharing.historicalSharingSessions,
    monthlyPlannedSharingSessions: sharing.monthlyPlannedSharingSessions,
  };
  const trendMonths = previousMonths(month, 4);
  const trendSummaries = trendMonths.map((trendMonth) => {
    const values = computeActiveValues(sources, stats, plans, trendMonth);
    const newHireTrend = computeNewHireValues(newHirePeople, trendMonth);
    const sharingTrend = computeSharingMetrics(sharingSessions, trendMonth);
    return {
      annualCompletedCourses: values.annualCompletedCourses,
      monthlyPlannedCourses: values.monthlyPlannedCourses,
      monthlyParticipants: values.monthlyParticipants,
      monthlyNewHires: newHireTrend.monthlyNewHires,
      historicalSharingSessions: sharingTrend.historicalSharingSessions,
      monthlyPlannedSharingSessions: sharingTrend.monthlyPlannedSharingSessions,
    } satisfies TrainingSummary;
  });
  const previousValues = computeActiveValues(
    sources,
    stats,
    plans,
    shiftMonth(month, -1),
  );
  const previousNewHire = computeNewHireValues(
    newHirePeople,
    shiftMonth(month, -1),
  );
  const previousSharing = computeSharingMetrics(
    sharingSessions,
    shiftMonth(month, -1),
  );
  const previousSummary: TrainingSummary = {
    annualCompletedCourses: previousValues.annualCompletedCourses,
    monthlyPlannedCourses: previousValues.monthlyPlannedCourses,
    monthlyParticipants: previousValues.monthlyParticipants,
    monthlyNewHires: previousNewHire.monthlyNewHires,
    historicalSharingSessions: previousSharing.historicalSharingSessions,
    monthlyPlannedSharingSessions:
      previousSharing.monthlyPlannedSharingSessions,
  };
  const details = mapTrainingDashboardDetails(
    sources,
    month,
    summary,
    newHire.plans,
    passScore,
  );

  return {
    month,
    availableMonths,
    summary,
    metricComparisons: Object.fromEntries(
      METRIC_KEYS.map((key) => [
        key,
        compareMetric(summary[key], previousSummary[key]),
      ]),
    ) as Record<TrainingMetricKey, TrainingMetricComparison>,
    metricTrends: Object.fromEntries(
      METRIC_KEYS.map((key) => [
        key,
        trendSummaries.map((trendSummary) => finite(trendSummary[key])),
      ]),
    ) as Record<TrainingMetricKey, number[]>,
    progress: active.progress,
    participation: active.participation,
    newHirePlans: newHire.plans,
    sharing: sharing.overview,
    courses: newHireCourses,
    details,
    sourceUpdatedAt: latestSourceUpdate(sources),
    syncedAt,
    sourceStatus: 'fresh',
    dataStatus:
      hasSelectedActiveData(sources, stats, plans, month) ||
      hasSelectedNewHireData(newHire) ||
      newHireCourses.length > 0 ||
      hasSelectedSharingData(sharing)
        ? 'ready'
        : 'empty',
  };
}

function mapNewHirePeople(records: BitableRecordItem[]): NewHirePerson[] {
  const candidates = records
    .map(mapNewHireCandidate)
    .filter((person): person is NewHirePerson => person !== null);
  const stableIdsByName = new Map<string, Set<string>>();
  for (const person of candidates) {
    if (!person.stableId) continue;
    const ids = stableIdsByName.get(person.normalizedName) ?? new Set<string>();
    ids.add(person.stableId);
    stableIdsByName.set(person.normalizedName, ids);
  }

  const merged = new Map<string, NewHirePerson>();
  for (const person of candidates) {
    const matchingIds = stableIdsByName.get(person.normalizedName);
    const matchingStableId =
      matchingIds?.size === 1 ? [...matchingIds][0] : null;
    const key = person.stableId
      ? `id:${person.stableId}`
      : matchingStableId
        ? `id:${matchingStableId}`
        : `name:${person.normalizedName}`;
    const existing = merged.get(key);
    merged.set(key, existing ? mergeNewHirePerson(existing, person) : person);
  }
  return [...merged.values()].sort((left, right) => {
    if (left.joinedAt !== right.joinedAt) {
      if (!left.joinedAt) return 1;
      if (!right.joinedAt) return -1;
      return right.joinedAt.localeCompare(left.joinedAt);
    }
    return (
      left.name.localeCompare(right.name, 'zh-CN') ||
      (left.stableId || '').localeCompare(right.stableId || '') ||
      left.sourceIndex - right.sourceIndex
    );
  });
}

function mapNewHireCandidate(
  record: BitableRecordItem,
  sourceIndex: number,
): NewHirePerson | null {
  const fields = record.fields || {};
  const identity = extractNewHireIdentity(fields);
  if (!identity) return null;
  return {
    stableId: identity.stableId,
    name: identity.name,
    normalizedName: identity.normalizedName,
    building: normalizeBuilding(fields['楼栋']),
    joinedAt: asDate(fields['入职日期']),
    dueAt: asDate(fields['计划考核截止日期']),
    requiredCourses: maxNumber([asNumber(fields['需培训课程数量'])]),
    completedCourses: maxNumber([asNumber(fields['已培训课程数量'])]),
    progress2026: asProgress(fields['培训进度（2026）']),
    finalScore:
      asNumber(fields['最终考核成绩']) ??
      asNumber(fields['最终考核成绩（旧）']),
    sourceIndex,
  };
}

function mergeNewHirePerson(
  existing: NewHirePerson,
  candidate: NewHirePerson,
): NewHirePerson {
  return {
    stableId: existing.stableId || candidate.stableId,
    name:
      (candidate.stableId && !existing.stableId
        ? candidate.name
        : existing.name) || candidate.name,
    normalizedName: existing.normalizedName,
    building: existing.building || candidate.building,
    joinedAt: existing.joinedAt || candidate.joinedAt,
    dueAt: existing.dueAt || candidate.dueAt,
    requiredCourses: maxNumber([
      existing.requiredCourses,
      candidate.requiredCourses,
    ]),
    completedCourses: maxNumber([
      existing.completedCourses,
      candidate.completedCourses,
    ]),
    progress2026: existing.progress2026 ?? candidate.progress2026,
    finalScore: existing.finalScore ?? candidate.finalScore,
    sourceIndex: Math.min(existing.sourceIndex, candidate.sourceIndex),
  };
}

function extractNewHireIdentity(fields: Record<string, unknown>): {
  stableId: string | null;
  name: string;
  normalizedName: string;
} | null {
  const identities = [
    ...extractIdentities(fields['人员']),
    ...extractIdentities(fields['新员工']),
    ...extractIdentities(fields['人员（文本）']),
  ];
  const stableId =
    identities.find((identity) => identity.stableId)?.stableId || null;
  const name = identities
    .map((identity) => identity.name.trim())
    .find(isRealPersonName);
  if (!name) return null;
  return {
    stableId,
    name,
    normalizedName: normalizePersonName(name),
  };
}

function normalizeActiveScoreEmployee(
  record: BitableRecordItem,
): BitableRecordItem {
  const fields = record.fields || {};
  const name = normalizePersonName(
    unwrap(fields[TRAINING_ACTIVE_EMPLOYEE_TEXT_FIELD]).join(''),
  );
  if (!name) return record;

  // A legacy ID is usable only when this row proves it belongs to the new name.
  const matchingIdentities = extractIdentities(fields['员工'])
    .filter(
      (identity) =>
        identity.stableId && normalizePersonName(identity.name) === name,
    )
    .map((identity) => ({ id: identity.stableId, name }));
  return {
    ...record,
    fields: {
      ...fields,
      员工: matchingIdentities.length > 0 ? matchingIdentities : name,
    },
  };
}

function extractIdentities(
  value: unknown,
): Array<{ stableId: string | null; name: string }> {
  if (!hasValue(value)) return [];
  if (Array.isArray(value)) return value.flatMap(extractIdentities);
  if (typeof value === 'string') {
    return [{ stableId: null, name: value.trim() }];
  }
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (hasValue(object.users)) return extractIdentities(object.users);
  if (hasValue(object.select)) return extractIdentities(object.select);
  const stableId = asText(
    object.id ?? object.open_id ?? object.user_id ?? object.union_id,
  );
  const name = asText(
    object.name ??
      object.user_name ??
      object.text ??
      object.label ??
      object.value,
  );
  if (stableId || name) {
    return [{ stableId: stableId || null, name }];
  }
  return [];
}

function isRealPersonName(name: string): boolean {
  const normalized = normalizePersonName(name);
  return (
    normalized.length > 0 &&
    !new Set([
      '-',
      '--',
      '—',
      '暂无',
      '无',
      '待定',
      '未填写',
      '空白',
      'null',
      'undefined',
    ]).has(normalized.toLowerCase())
  );
}

function normalizePersonName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function asProgress(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed === null) return null;
  const percent = asText(value).includes('%')
    ? parsed
    : parsed >= 0 && parsed <= 1
      ? parsed * 100
      : parsed;
  return Math.min(100, Math.max(0, roundOne(percent)));
}

function computeNewHireValues(
  people: NewHirePerson[],
  selectedMonth: string,
): NewHireValues {
  const { start, end } = monthBounds(selectedMonth);
  const selectedYear = selectedMonth.slice(0, 4);
  return {
    monthlyNewHires: people.filter(
      (person) => person.joinedAt?.slice(0, 7) === selectedMonth,
    ).length,
    plans: people
      .filter(
        (person) =>
          Boolean(person.joinedAt || person.dueAt) &&
          (!person.joinedAt || person.joinedAt <= end) &&
          (!person.dueAt || person.dueAt >= start),
      )
      .map((person, index) => ({
        id: `new-hire-${index + 1}`,
        name: person.name,
        building: person.building,
        joinedAt: person.joinedAt,
        assessmentDueAt: person.dueAt,
        requiredCourses: person.requiredCourses,
        completedCourses: person.completedCourses,
        progress:
          selectedYear === '2026' && person.progress2026 !== null
            ? person.progress2026
            : rate(person.completedCourses, person.requiredCourses),
        finalScore: person.finalScore,
      })),
  };
}

function monthBounds(month: string): { start: string; end: string } {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

function hasSelectedNewHireData(values: NewHireValues): boolean {
  return values.monthlyNewHires > 0 || values.plans.length > 0;
}

function mapNewHireCourses(
  planRecords: BitableRecordItem[],
  courseRecords: BitableRecordItem[],
): CampusTrainingDashboardResponse['courses'] {
  const candidates = planRecords
    .map(mapNewHireCourseCandidate)
    .filter(
      (candidate): candidate is NewHireCourseCandidate => candidate !== null,
    );
  const stableIdsByName = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (!candidate.stableId) continue;
    const ids =
      stableIdsByName.get(candidate.normalizedName) ?? new Set<string>();
    ids.add(candidate.stableId);
    stableIdsByName.set(candidate.normalizedName, ids);
  }

  const businessKeys = new Map<
    string,
    NewHireCourseCandidate & { learnerKey: string }
  >();
  for (const candidate of candidates) {
    const matchingIds = stableIdsByName.get(candidate.normalizedName);
    const matchingStableId =
      matchingIds?.size === 1 ? [...matchingIds][0] : null;
    const learnerKey = candidate.stableId
      ? `id:${candidate.stableId}`
      : matchingStableId
        ? `id:${matchingStableId}`
        : `name:${candidate.normalizedName}`;
    const businessKey = `${learnerKey}\u001f${candidate.course}\u001f${candidate.week}`;
    const existing = businessKeys.get(businessKey);
    businessKeys.set(
      businessKey,
      existing
        ? {
            ...existing,
            category: existing.category || candidate.category,
            completed: existing.completed || candidate.completed,
          }
        : { ...candidate, learnerKey },
    );
  }

  const configurations = new Map<
    string,
    { category: string; instructor: string }
  >();
  for (const record of courseRecords) {
    const fields = record.fields || {};
    const course = asText(fields['培训课程名称']);
    if (!course || configurations.has(course)) continue;
    configurations.set(course, {
      category: asText(fields['课程大类']),
      instructor: asText(fields['讲师']),
    });
  }

  const aggregates = new Map<
    string,
    { total: number; completed: number; category: string }
  >();
  for (const plan of businessKeys.values()) {
    const aggregate = aggregates.get(plan.course) ?? {
      total: 0,
      completed: 0,
      category: '',
    };
    aggregate.total += 1;
    if (plan.completed) aggregate.completed += 1;
    aggregate.category ||= plan.category;
    aggregates.set(plan.course, aggregate);
  }

  return [...aggregates.entries()]
    .map(([course, aggregate]) => {
      const configuration = configurations.get(course);
      return {
        id: `new-hire-course:${encodeURIComponent(course)}`,
        rank: 0,
        category: configuration?.category || aggregate.category,
        course,
        instructor: configuration?.instructor || '',
        completionRate: rate(aggregate.completed, aggregate.total),
      };
    })
    .sort(
      (left, right) =>
        right.completionRate - left.completionRate ||
        left.course.localeCompare(right.course, 'zh-CN'),
    )
    .map((course, index) => ({ ...course, rank: index + 1 }));
}

function mapNewHireCourseCandidate(
  record: BitableRecordItem,
): NewHireCourseCandidate | null {
  const fields = record.fields || {};
  const identities = [
    ...extractIdentities(fields['学员']),
    ...extractIdentities(fields['学员名字（文本）']),
  ];
  const stableId =
    identities.find((identity) => identity.stableId)?.stableId || null;
  const name = identities
    .map((identity) => identity.name.trim())
    .find(isRealPersonName);
  const course =
    asText(
      fields['培训课程名称（考核类型为理论考核的需与题库中的名称一致）'],
    ) || asText(fields['培训课程']);
  if (!name || !course) return null;
  const status = asText(fields['流程状态']);
  return {
    stableId,
    name,
    normalizedName: normalizePersonName(name),
    course,
    week: asText(fields['新员工第（）周培训']),
    category: asText(fields['课程大类']),
    completed:
      asDate(fields['培训考核完成时间']) !== null ||
      new Set(['已完成', '已通过', '考核结束', '已完成培训考核']).has(status),
  };
}

function mapSharingSessions(
  records: BitableRecordItem[],
  yearHint: string,
): SharingSessionRecord[] {
  return records
    .map((record): SharingSessionRecord | null => {
      const fields = record.fields || {};
      const topic = asText(fields['分享主题']);
      if (!topic) return null;
      const startTimestamp = asTimestamp(fields['开始时间']);
      const endTimestamp = asTimestamp(fields['结束时间']);
      const rawEventMonth = normalizeMonth(fields['月度'], yearHint);
      const eventMonth =
        (startTimestamp === null
          ? null
          : formatShanghaiMonth(new Date(startTimestamp))) || rawEventMonth;
      if (!eventMonth) return null;
      const presenterIdentities = extractIdentities(fields['分享人']);
      return {
        topic,
        category: asText(fields['分享类型']) || '未分类',
        status: normalizeSharingStatus(asText(fields['会议进度（勿动）'])),
        eventMonth,
        startTimestamp,
        endTimestamp,
        presenterIds: unique(
          presenterIdentities
            .map((identity) => identity.stableId)
            .filter((id): id is string => Boolean(id)),
        ),
        presenterNames: unique(
          presenterIdentities
            .map((identity) => normalizePersonName(identity.name))
            .filter(Boolean),
        ),
        participants: asPeople(fields['参会人 (人员 )']).length,
        hasMaterial:
          Boolean(asText(fields['演示文档/PPT（链接）'])) ||
          Boolean(asText(fields['会议回放&妙记链接'])),
        scheduled:
          startTimestamp !== null ||
          endTimestamp !== null ||
          rawEventMonth !== null,
      };
    })
    .filter((session): session is SharingSessionRecord => session !== null);
}

function normalizeSharingStatus(status: string): string {
  switch (status) {
    case '会议已结束':
      return '已结束';
    case '会议已终止':
      return '已终止';
    default:
      return status;
  }
}

function computeSharingMetrics(
  sessions: SharingSessionRecord[],
  selectedMonth: string,
): Pick<
  SharingValues,
  'historicalSharingSessions' | 'monthlyPlannedSharingSessions'
> {
  return {
    historicalSharingSessions: sessions.filter(
      (session) =>
        session.status === '已结束' &&
        session.eventMonth.localeCompare(selectedMonth) <= 0,
    ).length,
    monthlyPlannedSharingSessions: sessions.filter(
      (session) =>
        session.eventMonth === selectedMonth &&
        session.scheduled &&
        session.status !== '已终止',
    ).length,
  };
}

function computeSharingValues(
  sessions: SharingSessionRecord[],
  scoreRecords: BitableRecordItem[],
  interestRecords: BitableRecordItem[],
  selectedMonth: string,
): SharingValues {
  const metrics = computeSharingMetrics(sessions, selectedMonth);
  const completedSessions = sessions.filter(
    (session) =>
      session.status === '已结束' &&
      session.eventMonth.localeCompare(selectedMonth) <= 0,
  );
  const categoryCounts = new Map<string, number>();
  for (const session of completedSessions) {
    categoryCounts.set(
      session.category,
      (categoryCounts.get(session.category) || 0) + 1,
    );
  }
  const tones = ['blue', 'teal', 'orange', 'purple'] as const;
  const categories = [...categoryCounts.entries()]
    .sort(
      ([leftLabel, leftSessions], [rightLabel, rightSessions]) =>
        rightSessions - leftSessions ||
        leftLabel.localeCompare(rightLabel, 'zh-CN'),
    )
    .map(([label, count], index) => ({
      key: `sharing-category:${encodeURIComponent(label)}`,
      label,
      sessions: count,
      percentage:
        completedSessions.length > 0
          ? roundOne((count / completedSessions.length) * 100)
          : 0,
      tone: tones[index % tones.length],
    }));
  const trend = previousMonths(selectedMonth, 5).map((month) => ({
    month: `${Number(month.slice(5, 7))}月`,
    sessions: completedSessions.filter(
      (session) => session.eventMonth === month,
    ).length,
  }));
  const totalHours = roundOne(
    completedSessions.reduce((total, session) => {
      if (
        session.startTimestamp === null ||
        session.endTimestamp === null ||
        session.endTimestamp <= session.startTimestamp
      ) {
        return total;
      }
      return (
        total +
        (session.endTimestamp - session.startTimestamp) / (60 * 60 * 1000)
      );
    }, 0),
  );

  return {
    ...metrics,
    overview: {
      categories,
      trend,
      participants: completedSessions.reduce(
        (total, session) => total + session.participants,
        0,
      ),
      totalHours,
      satisfaction: computeSharingSatisfaction(completedSessions, scoreRecords),
      materials: completedSessions.filter((session) => session.hasMaterial)
        .length,
      interests: mapSharingInterests(interestRecords),
    },
  };
}

function computeSharingSatisfaction(
  completedSessions: SharingSessionRecord[],
  scoreRecords: BitableRecordItem[],
): number {
  const ratings: number[] = [];
  for (const record of scoreRecords) {
    const fields = record.fields || {};
    const topic = asText(fields['主题名']);
    const rating = asRatingPercent(fields['评分']);
    if (!topic || rating === null) continue;
    const topicSessions = completedSessions.filter(
      (session) => session.topic === topic,
    );
    if (topicSessions.length === 0) continue;
    const presenterIdentities = extractIdentities(fields['分享人']);
    const presenterIds = unique(
      presenterIdentities
        .map((identity) => identity.stableId)
        .filter((id): id is string => Boolean(id)),
    );
    const matches = topicSessions.some(
      (session) =>
        presenterIds.length === 0 ||
        session.presenterIds.length === 0 ||
        presenterIds.some((id) => session.presenterIds.includes(id)),
    );
    if (matches) ratings.push(rating);
  }
  return ratings.length > 0
    ? roundOne(
        ratings.reduce((total, rating) => total + rating, 0) / ratings.length,
      )
    : 0;
}

function asRatingPercent(value: unknown): number | null {
  const text = asText(value);
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed) || ![6, 8, 10].includes(parsed)) return null;
  return parsed * 10;
}

function mapSharingInterests(
  records: BitableRecordItem[],
): CampusTrainingDashboardResponse['sharing']['interests'] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const label = asText(record.fields?.['兴趣板块']);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, submissions]) => ({ label, submissions }))
    .sort(
      (left, right) =>
        right.submissions - left.submissions ||
        left.label.localeCompare(right.label, 'zh-CN'),
    );
}

function asTimestamp(value: unknown): number | null {
  if (!hasValue(value)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const timestamp = asTimestamp(item);
      if (timestamp !== null) return timestamp;
    }
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value >= 20_000 && value <= 80_000) {
      const date = excelSerialToDate(value);
      return date ? Date.parse(`${date}T00:00:00+08:00`) : null;
    }
    const timestamp =
      Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(timestamp);
    return isSupportedBusinessDate(date) ? timestamp : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^\d{5}(?:\.\d+)?$/.test(text)) return asTimestamp(Number(text));
    if (/^-?\d{10,13}$/.test(text)) return asTimestamp(Number(text));
    const timestamp = Date.parse(text);
    return isSupportedBusinessDate(new Date(timestamp)) ? timestamp : null;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'value', 'text']) {
      const timestamp = asTimestamp(object[key]);
      if (timestamp !== null) return timestamp;
    }
  }
  return null;
}

function hasSelectedSharingData(values: SharingValues): boolean {
  return (
    values.historicalSharingSessions > 0 ||
    values.monthlyPlannedSharingSessions > 0 ||
    values.overview.interests.length > 0
  );
}

function computeActiveValues(
  sources: TrainingDashboardSources,
  stats: ActiveStat[],
  plans: ActivePlan[],
  month: string,
): ActiveValues {
  const selectedStats = stats.filter((item) => item.month === month);
  const selectedPlans = plans.filter((item) => item.month === month);
  const selectedYear = month.slice(0, 4);
  const buildings = resolveBuildingOrder(
    selectedStats,
    selectedPlans,
    sources.activeScores,
    month,
  );
  const progress = buildings.map((building) => {
    const buildingStats = selectedStats.filter(
      (item) => item.building === building,
    );
    const planned = maxNumber(
      buildingStats.map((item) => item.required ?? item.planned),
    );
    const completed = maxNumber(buildingStats.map((item) => item.completed));
    return {
      building,
      planned,
      completed,
      rate: rate(completed, planned),
    };
  });

  const scorePeople = scorePeopleByBuilding(sources.activeScores, month);
  const participation = buildings.map((building) => {
    const buildingStats = selectedStats.filter(
      (item) => item.building === building,
    );
    const detailedPeople = scorePeople.get(building);
    const people =
      detailedPeople && detailedPeople.size > 0
        ? detailedPeople.size
        : maxNumber(
            buildingStats.map((item) =>
              selectedYear === '2026'
                ? (item.people2026 ?? item.people)
                : item.people,
            ),
          );
    const target = maxNumber(buildingStats.map((item) => item.target));
    const progressItem = progress.find((item) => item.building === building);
    const sourceTrainingCompletionRate = maxOptionalNumber(
      buildingStats.map((item) => item.trainingCompletionRate),
    );
    const assessmentPassRate = maxOptionalNumber(
      buildingStats.map((item) => item.assessmentPassRate),
    );
    return {
      building,
      people,
      target,
      trainingCompletionRate:
        sourceTrainingCompletionRate ?? progressItem?.rate ?? 0,
      assessmentPassRate,
    };
  });

  const courseNames = new Set(
    selectedPlans.map((item) => item.course).filter(Boolean),
  );
  const monthlyPlannedCourses =
    courseNames.size > 0
      ? courseNames.size
      : maxNumber(selectedStats.map((item) => item.required));
  const throughSelectedMonth = stats.filter(
    (item) =>
      item.month?.startsWith(`${selectedYear}-`) &&
      item.month.localeCompare(month) <= 0,
  );
  const cumulativeValues = throughSelectedMonth
    .map((item) => item.cumulative)
    .filter(
      (value): value is number =>
        value !== null && Number.isFinite(value) && value >= 0,
    );
  const annualCompletedCourses =
    cumulativeValues.length > 0
      ? maxNumber(cumulativeValues)
      : countCompletedPlans(plans, selectedYear, month);

  return {
    annualCompletedCourses: finite(annualCompletedCourses),
    monthlyPlannedCourses: finite(monthlyPlannedCourses),
    monthlyParticipants: participation.reduce(
      (total, item) => total + item.people,
      0,
    ),
    progress,
    participation,
  };
}

function mapActiveStat(record: BitableRecordItem): ActiveStat {
  const fields = record.fields || {};
  const year = asYear(fields['年份']);
  const month = normalizeMonth(fields['月份'], year);
  return {
    year,
    month,
    building: normalizeBuilding(fields['楼栋']),
    required: asNumber(fields['本月需考核课程数量']),
    planned: asNumber(fields['本月培训课程数量']),
    completed:
      asNumber(fields['已完成考核的课程数量']) ??
      asNumber(fields['已完成培训课程数量']),
    people: asNumber(fields['培训人数']),
    people2026: asNumber(fields['培训人数（2026）']),
    target: asNumber(fields['🧑在岗员工培训人数']),
    trainingCompletionRate: asPercentage(fields['培训完成率']),
    assessmentPassRate: asPercentage(fields['考核达标率']),
    cumulative: asNumber(fields['累计-已完成培训数量']),
  };
}

function mapActivePlan(record: BitableRecordItem): ActivePlan {
  const fields = record.fields || {};
  const year = asYear(fields['培训年份']);
  const status = asText(fields['培训状态（此格为系统修改）']);
  return {
    month: normalizeMonth(fields['培训月份'], year),
    building: normalizeBuilding(fields['楼栋/专业']),
    course: asText(fields['培训课程名称']),
    completed:
      status === '已完成培训考核' || hasValue(fields['培训考核完成时间']),
  };
}

function scorePeopleByBuilding(
  records: BitableRecordItem[],
  selectedMonth: string,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const selectedYear = selectedMonth.slice(0, 4);
  for (const record of records) {
    const fields = record.fields || {};
    if (resolveScoreMonth(record, selectedYear) !== selectedMonth) continue;
    const building = normalizeBuilding(fields['楼栋']);
    if (!building) continue;
    const keys = asPeople(fields['员工']);
    if (keys.length === 0) continue;
    const people = result.get(building) ?? new Set<string>();
    keys.forEach((key) => people.add(key));
    result.set(building, people);
  }
  return result;
}

function countCompletedPlans(
  plans: ActivePlan[],
  selectedYear: string,
  selectedMonth: string,
): number {
  const keys = new Set<string>();
  for (const plan of plans) {
    if (
      !plan.completed ||
      !plan.month?.startsWith(`${selectedYear}-`) ||
      plan.month.localeCompare(selectedMonth) > 0 ||
      !plan.course
    ) {
      continue;
    }
    keys.add(`${plan.month}\u001f${plan.building}\u001f${plan.course}`);
  }
  return keys.size;
}

function hasSelectedActiveData(
  sources: TrainingDashboardSources,
  stats: ActiveStat[],
  plans: ActivePlan[],
  month: string,
): boolean {
  if (stats.some((item) => item.month === month)) return true;
  if (plans.some((item) => item.month === month)) return true;
  const selectedYear = month.slice(0, 4);
  return sources.activeScores.some((record) => {
    return (
      isValidActiveScore(record) &&
      resolveScoreMonth(record, selectedYear) === month
    );
  });
}

function resolveBuildingOrder(
  stats: ActiveStat[],
  plans: ActivePlan[],
  scoreRecords: BitableRecordItem[],
  selectedMonth: string,
): string[] {
  const selectedYear = selectedMonth.slice(0, 4);
  const scoreBuildings = scoreRecords
    .filter(
      (record) =>
        isValidActiveScore(record) &&
        resolveScoreMonth(record, selectedYear) === selectedMonth,
    )
    .map((record) => normalizeBuilding(record.fields?.['楼栋']));
  const unknownBuildings = unique([
    ...stats.map((item) => item.building),
    ...plans.map((item) => item.building),
    ...scoreBuildings,
  ]).filter(
    (building) =>
      Boolean(building) &&
      !BUILDINGS.includes(building as (typeof BUILDINGS)[number]),
  );
  return [...BUILDINGS, ...unknownBuildings];
}

function isValidActiveScore(record: BitableRecordItem): boolean {
  const fields = record.fields || {};
  return (
    Boolean(normalizeBuilding(fields['楼栋'])) &&
    asPeople(fields['员工']).length > 0
  );
}

function resolveScoreMonth(
  record: BitableRecordItem,
  selectedYearHint?: string | null,
): string | null {
  const fields = record.fields || {};
  const primary = parseMonth(fields['月份']);
  const planned = parseMonth(fields['月份（计划）']);
  if (planned?.year) return `${planned.year}-${planned.month}`;
  if (primary?.year) return `${primary.year}-${primary.month}`;
  const recordYear =
    asYear(fields['年份']) ||
    asYear(fields['培训年份']) ||
    asYear(fields['年度']);
  const year = recordYear || selectedYearHint;
  const month = primary?.month || planned?.month;
  return year && month ? `${year}-${month}` : null;
}

function latestSourceUpdate(sources: TrainingDashboardSources): string | null {
  const latest = Object.values(sources)
    .flat()
    .map((record) => normalizeTimestamp(record.last_modified_time))
    .filter((value): value is number => value !== null)
    .reduce<number | null>(
      (current, value) =>
        current === null || value > current ? value : current,
      null,
    );
  return latest === null ? null : new Date(latest).toISOString();
}

function normalizeTimestamp(value: number | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  const timestamp = Number(value);
  const milliseconds =
    timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  return Number.isFinite(new Date(milliseconds).getTime())
    ? milliseconds
    : null;
}

function normalizeRequestedMonth(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function normalizeMonth(
  value: unknown,
  yearHint?: string | null,
): string | null {
  const parsed = parseMonth(value);
  if (!parsed) return null;
  const year = parsed.year || yearHint;
  return year ? `${year}-${parsed.month}` : null;
}

function parseMonth(
  value: unknown,
): { year: string | null; month: string } | null {
  const text = asText(value);
  if (!text) return null;
  const monthMatch = text.match(/^(1[0-2]|0?[1-9])(?:\s*月)?$/);
  if (monthMatch) {
    return { year: null, month: monthMatch[1].padStart(2, '0') };
  }
  const dateMonth = monthFromDateValue(value);
  if (dateMonth) {
    return { year: dateMonth.slice(0, 4), month: dateMonth.slice(5, 7) };
  }
  if (HANDWRITTEN_DATE_PATTERN.test(text)) return null;
  const fullMatch = text.match(
    /((?:19|20)\d{2})\s*(?:年|[-/.])\s*(1[0-2]|0?[1-9])(?:\s*月)?/,
  );
  if (fullMatch) {
    return {
      year: fullMatch[1],
      month: fullMatch[2].padStart(2, '0'),
    };
  }
  return null;
}

function asYear(value: unknown): string | null {
  const match = asText(value).match(/(?:19|20)\d{2}/);
  return match?.[0] ?? null;
}

function normalizeBuilding(value: unknown): string {
  const text = asText(value).trim().toUpperCase();
  const match = text.match(/(?:^|[^A-Z])([ABCDEH])\s*(?:楼|栋)?(?:$|[^A-Z])/);
  return match?.[1] ? `${match[1]}楼` : text;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  for (const item of unwrap(value)) {
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'string') continue;
    const normalized = item.trim().replace(/[%％,\s]/g, '');
    if (!normalized) continue;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asPercentage(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed === null) return null;
  const percentage = parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.min(100, Math.max(0, roundOne(percentage)));
}

function asText(value: unknown): string {
  return (
    unwrap(value)
      .map((item) => String(item).trim())
      .find(Boolean) ?? ''
  );
}

function unwrap(value: unknown): Array<string | number | boolean> {
  if (!hasValue(value)) return [];
  if (Array.isArray(value)) return value.flatMap(unwrap);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return [value];
  }
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (hasValue(object.users)) return unwrap(object.users);
  if (hasValue(object.select)) return unwrap(object.select);
  for (const key of ['value', 'name', 'text', 'label', 'title', 'user_name']) {
    if (hasValue(object[key])) return unwrap(object[key]);
  }
  for (const key of ['link', 'url', 'href']) {
    if (hasValue(object[key])) return unwrap(object[key]);
  }
  return [];
}

function asPeople(value: unknown): string[] {
  if (!hasValue(value)) return [];
  if (Array.isArray(value)) return unique(value.flatMap(asPeople));
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text ? [`name:${text}`] : [];
  }
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (hasValue(object.users)) return asPeople(object.users);
  if (hasValue(object.select)) return asPeople(object.select);
  const id = asText(
    object.id ?? object.open_id ?? object.user_id ?? object.union_id,
  );
  if (id) return [`id:${id}`];
  const name = asText(
    object.name ?? object.user_name ?? object.text ?? object.value,
  );
  return name ? [`name:${name}`] : [];
}

function monthFromDateValue(value: unknown): string | null {
  if (typeof value === 'number' && value >= 20_000 && value <= 80_000) {
    return excelSerialToDate(value)?.slice(0, 7) ?? null;
  }
  const text = asText(value);
  if (!text || !/[-/:年月日T]/.test(text)) return null;
  const date = asDate(value);
  return date?.slice(0, 7) ?? null;
}

function asDate(value: unknown): string | null {
  if (!hasValue(value)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const date = asDate(item);
      if (date) return date;
    }
    return null;
  }
  if (typeof value === 'number') {
    if (value >= 20_000 && value <= 80_000) return excelSerialToDate(value);
    const timestamp =
      Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    return formatShanghaiDate(new Date(timestamp));
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^\d{5}(?:\.\d+)?$/.test(text)) {
      return excelSerialToDate(Number(text));
    }
    if (/^-?\d{10,13}$/.test(text)) return asDate(Number(text));
    const normalized = text
      .replace(/年|月/g, '-')
      .replace(/日/g, '')
      .replace(/\//g, '-');
    const plain = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (plain) {
      return normalizeCalendarDate(plain[1], plain[2], plain[3]);
    }
    return formatShanghaiDate(new Date(normalized));
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'value', 'text']) {
      const date = asDate(object[key]);
      if (date) return date;
    }
  }
  return null;
}

function monthFromDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatShanghaiMonth(date);
}

function normalizeCalendarDate(
  yearText: string,
  monthText: string,
  dayText: string,
): string | null {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < MIN_BUSINESS_YEAR ||
    year > MAX_BUSINESS_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatShanghaiDate(date: Date): string | null {
  if (!isSupportedBusinessDate(date)) return null;
  const parts = shanghaiParts(date, true);
  return parts.day ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

function isSupportedBusinessDate(date: Date): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const year = Number(shanghaiParts(date, false).year);
  return year >= MIN_BUSINESS_YEAR && year <= MAX_BUSINESS_YEAR;
}

function formatShanghaiMonth(date: Date): string {
  const parts = shanghaiParts(date, false);
  return `${parts.year}-${parts.month}`;
}

function shanghaiParts(
  date: Date,
  includeDay: boolean,
): { year: string; month: string; day?: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    ...(includeDay ? { day: '2-digit' } : {}),
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    year: values.year || '1970',
    month: values.month || '01',
    ...(includeDay ? { day: values.day || '01' } : {}),
  };
}

function previousMonths(month: string, previousCount: number): string[] {
  return Array.from({ length: previousCount + 1 }, (_, index) =>
    shiftMonth(month, index - previousCount),
  );
}

function shiftMonth(month: string, offset: number): string {
  const [yearText, monthText] = month.split('-');
  const date = new Date(
    Date.UTC(Number(yearText), Number(monthText) - 1 + offset, 1),
  );
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function compareMetric(
  currentValue: number,
  previousValue: number,
): TrainingMetricComparison {
  const current = finite(currentValue);
  const previous = finite(previousValue);
  const direction = current >= previous ? 'up' : 'down';
  const change =
    previous === 0
      ? current > 0
        ? 100
        : 0
      : roundOne(Math.abs(((current - previous) / previous) * 100));
  return { change: finite(change), direction, favorable: direction === 'up' };
}

function rate(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(100, Math.max(0, roundOne((value / target) * 100)));
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function maxNumber(values: Array<number | null>): number {
  const numbers = values.filter(
    (value): value is number =>
      value !== null && Number.isFinite(value) && value >= 0,
  );
  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

function maxOptionalNumber(values: Array<number | null>): number | null {
  const numbers = values.filter(
    (value): value is number =>
      value !== null && Number.isFinite(value) && value >= 0,
  );
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasValue);
  return true;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
