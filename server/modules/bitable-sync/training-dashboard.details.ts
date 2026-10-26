import type {
  ActiveTrainingCoursePlanDetail,
  NewHirePlan,
  TrainingAssessmentDetail,
  TrainingAssessmentStatus,
  TrainingDashboardDetails,
  TrainingParticipantDetail,
  TrainingSharingSessionDetail,
  TrainingSummary,
} from '../../../shared/campus-training-dashboard.interface';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import type { TrainingDashboardSources } from './training-dashboard.mapper';

const DEFAULT_PASS_SCORE = 80;
const MIN_BUSINESS_YEAR = 2000;
const MAX_BUSINESS_YEAR = 2100;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BUILDING_ORDER = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼'];

interface PersonIdentity {
  key: string;
  name: string;
}

interface MutableAssessment {
  course: string;
  score: number | null;
  signedIn: boolean | null;
  status: TrainingAssessmentStatus;
}

interface MutableParticipant {
  name: string;
  building: string;
  assessments: Map<string, MutableAssessment>;
}

interface MutableCoursePlan {
  month: string;
  building: string;
  course: string;
  status: string;
  assignedParticipantKeys: Set<string>;
  actualParticipantKeys: Set<string>;
  completedAt: string | null;
}

interface MutableSharingSession {
  month: string;
  topic: string;
  category: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  presenterNames: string[];
  participantCount: number;
  buildings: string[];
  durationHours: number;
  hasMaterial: boolean;
  scheduled: boolean;
}

export function mapTrainingDashboardDetails(
  sources: TrainingDashboardSources,
  month: string,
  summary: TrainingSummary,
  newHirePlans: NewHirePlan[],
  passScore = DEFAULT_PASS_SCORE,
): TrainingDashboardDetails {
  const assessmentPassScore = normalizePassScore(passScore);
  const activeCoursePlans = mapActiveCoursePlans(
    sources.activePlans,
    sources.activeScores,
    month,
  );
  const participants = mapMonthlyParticipants(
    sources.activeScores,
    month,
    assessmentPassScore,
  );
  const newHires = newHirePlans.filter((plan) =>
    plan.joinedAt?.startsWith(`${month}-`),
  );
  const sharingSessions = mapRelevantSharingSessions(
    sources.sharingSessions,
    month,
  );

  const annualCompletedCourses = new Set(
    activeCoursePlans
      .filter(isCompletedCoursePlan)
      .map(({ month: planMonth, course }) => `${planMonth}\u001f${course}`),
  ).size;
  const monthlyPlannedCourses = new Set(
    activeCoursePlans
      .filter(
        (plan) => plan.month === month && !isTerminatedCoursePlan(plan.status),
      )
      .map(({ course }) => course),
  ).size;
  const historicalSharingSessions = sharingSessions.filter(
    (session) =>
      session.status === '已结束' && session.month.localeCompare(month) <= 0,
  ).length;
  const monthlyPlannedSharingSessions = sharingSessions.filter(
    (session) => session.month === month && session.status !== '已终止',
  ).length;
  const progressReconciliation = progressCompletionReconciliationNote(
    sources.activeStats,
    activeCoursePlans,
    month,
  );

  return {
    assessmentPassScore,
    activeCoursePlans,
    participants,
    newHires,
    sharingSessions,
    reconciliationNotes: [
      reconciliationNote(
        '本年度已培训课程',
        summary.annualCompletedCourses,
        annualCompletedCourses,
        '看板累计统计字段',
        '计划表按月份×课程去重',
      ),
      reconciliationNote(
        '本月计划性培训课程',
        summary.monthlyPlannedCourses,
        monthlyPlannedCourses,
      ),
      reconciliationNote(
        '本月参与培训人员',
        summary.monthlyParticipants,
        participants.length,
      ),
      reconciliationNote(
        '本月新人培训',
        summary.monthlyNewHires,
        newHires.length,
      ),
      reconciliationNote(
        '历史分享会',
        summary.historicalSharingSessions,
        historicalSharingSessions,
      ),
      reconciliationNote(
        '本月计划进行分享会',
        summary.monthlyPlannedSharingSessions,
        monthlyPlannedSharingSessions,
      ),
      progressReconciliation,
    ].filter((note): note is string => note !== null),
  };
}

function reconciliationNote(
  label: string,
  dashboardValue: number,
  traceableCount: number,
  dashboardLabel = '统计卡',
  traceableLabel = '当前可追溯明细',
): string | null {
  return dashboardValue === traceableCount
    ? null
    : `${label}：${dashboardLabel}=${dashboardValue}，${traceableLabel}=${traceableCount}`;
}

function progressCompletionReconciliationNote(
  records: BitableRecordItem[],
  activeCoursePlans: ActiveTrainingCoursePlanDetail[],
  selectedMonth: string,
): string | null {
  const completedByBuilding = new Map<string, number>();
  for (const record of records) {
    const fields = record.fields || {};
    const year = asText(fields['年份']).match(/(?:20)\d{2}/)?.[0] ?? null;
    const month = normalizeMonth(fields['月份'], year);
    const building = normalizeBuilding(fields['楼栋']);
    const completed =
      asNumber(fields['已完成考核的课程数量']) ??
      asNumber(fields['已完成培训课程数量']);
    if (
      month !== selectedMonth ||
      !building ||
      completed === null ||
      completed < 0
    ) {
      continue;
    }
    completedByBuilding.set(
      building,
      Math.max(completedByBuilding.get(building) ?? 0, completed),
    );
  }
  const statsCompleted = [...completedByBuilding.values()].reduce(
    (total, value) => total + value,
    0,
  );
  const planCompleted = new Set(
    activeCoursePlans
      .filter(
        (plan) =>
          plan.month === selectedMonth &&
          !isTerminatedCoursePlan(plan.status) &&
          isCompletedCoursePlan(plan),
      )
      .map(({ building, course }) => `${building}\u001f${course}`),
  ).size;
  if (statsCompleted === planCompleted) return null;
  return `本月考核进展：统计表楼栋完成合计=${statsCompleted}，计划表楼栋×课程完成标记=${planCompleted}，当前无法逐项追溯`;
}

function mapActiveCoursePlans(
  planRecords: BitableRecordItem[],
  scoreRecords: BitableRecordItem[],
  selectedMonth: string,
): ActiveTrainingCoursePlanDetail[] {
  const selectedYear = selectedMonth.slice(0, 4);
  const grouped = new Map<string, MutableCoursePlan>();
  const signedInParticipants = mapSignedInParticipantsByCourse(
    scoreRecords,
    selectedMonth,
  );

  for (const record of planRecords) {
    const fields = record.fields || {};
    const month = resolvePlanMonth(fields);
    const course = asText(fields['培训课程名称']);
    const building = normalizeBuilding(fields['楼栋/专业']);
    if (
      !month ||
      !month.startsWith(`${selectedYear}-`) ||
      month.localeCompare(selectedMonth) > 0 ||
      !course ||
      !building
    ) {
      continue;
    }

    const key = `${month}\u001f${building}\u001f${course}`;
    const item = grouped.get(key) ?? {
      month,
      building,
      course,
      status: '',
      assignedParticipantKeys: new Set<string>(),
      actualParticipantKeys: new Set<string>(),
      completedAt: null,
    };
    const status = asText(fields['培训状态（此格为系统修改）']);
    if (status) item.status = preferCoursePlanStatus(item.status, status);
    for (const person of [
      ...extractPeople(fields['在岗员工培训对应人员']),
      ...extractPeople(fields['在岗员工培训对应人员（公式）']),
    ]) {
      item.assignedParticipantKeys.add(participantCountKey(person));
    }
    for (const person of extractPeople(fields['实际参与培训人'])) {
      item.actualParticipantKeys.add(participantCountKey(person));
    }
    const completedAt = asBusinessDate(fields['培训考核完成时间']);
    if (
      completedAt &&
      (!item.completedAt || completedAt.localeCompare(item.completedAt) > 0)
    ) {
      item.completedAt = completedAt;
    }
    grouped.set(key, item);
  }

  for (const [key, participantKeys] of signedInParticipants) {
    const item = grouped.get(key);
    if (!item) continue;
    participantKeys.forEach((participantKey) =>
      item.actualParticipantKeys.add(participantKey),
    );
  }

  return [...grouped.values()]
    .sort(
      (left, right) =>
        left.month.localeCompare(right.month) ||
        buildingRank(left.building) - buildingRank(right.building) ||
        left.course.localeCompare(right.course, 'zh-CN'),
    )
    .map((item, index) => ({
      id: `course-plan-${index + 1}`,
      month: item.month,
      building: item.building,
      course: item.course,
      status: item.status,
      assignedParticipants: item.assignedParticipantKeys.size,
      actualParticipants: item.actualParticipantKeys.size,
      completedAt: item.completedAt,
    }));
}

function mapSignedInParticipantsByCourse(
  records: BitableRecordItem[],
  selectedMonth: string,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const record of records) {
    const fields = record.fields || {};
    if (
      resolveScoreMonth(fields, selectedMonth) !== selectedMonth ||
      asBoolean(fields['签到']) !== true
    ) {
      continue;
    }
    const building = normalizeBuilding(fields['楼栋']);
    const course = asText(fields['课程']);
    const people = extractPeople(fields['员工']);
    if (!building || !course || people.length === 0) continue;
    const key = `${selectedMonth}\u001f${building}\u001f${course}`;
    const participantKeys = result.get(key) ?? new Set<string>();
    people.forEach((person) =>
      participantKeys.add(participantCountKey(person)),
    );
    result.set(key, participantKeys);
  }
  return result;
}

function participantCountKey(person: PersonIdentity): string {
  return person.key;
}

function preferCoursePlanStatus(current: string, candidate: string): string {
  if (!current) return candidate;
  if (candidate === '已完成培训考核') return candidate;
  return current;
}

function isCompletedCoursePlan(plan: ActiveTrainingCoursePlanDetail): boolean {
  return plan.status === '已完成培训考核' || plan.completedAt !== null;
}

function isTerminatedCoursePlan(status: string): boolean {
  return /终止|取消|作废/.test(status);
}

function mapMonthlyParticipants(
  records: BitableRecordItem[],
  selectedMonth: string,
  passScore: number,
): TrainingParticipantDetail[] {
  const participants = new Map<string, MutableParticipant>();

  for (const record of records) {
    const fields = record.fields || {};
    if (resolveScoreMonth(fields, selectedMonth) !== selectedMonth) continue;
    const building = normalizeBuilding(fields['楼栋']);
    const course = asText(fields['课程']);
    const identities = extractPeople(fields['员工']);
    if (!building || !course || identities.length === 0) continue;

    const score = asNumber(fields['考试分数']);
    const signedIn = asBoolean(fields['签到']);
    const assessment: MutableAssessment = {
      course,
      score,
      signedIn,
      status: assessmentStatus(score, signedIn, passScore),
    };

    for (const identity of identities) {
      const key = `${identity.key}\u001f${building}`;
      const participant = participants.get(key) ?? {
        name: identity.name,
        building,
        assessments: new Map<string, MutableAssessment>(),
      };
      participant.assessments.set(
        course,
        chooseAssessment(participant.assessments.get(course), assessment),
      );
      participants.set(key, participant);
    }
  }

  return [...participants.values()]
    .sort(
      (left, right) =>
        buildingRank(left.building) - buildingRank(right.building) ||
        left.name.localeCompare(right.name, 'zh-CN'),
    )
    .map((participant, participantIndex) => {
      const participantId = `participant-${participantIndex + 1}`;
      const assessments: TrainingAssessmentDetail[] = [
        ...participant.assessments.values(),
      ]
        .sort((left, right) => left.course.localeCompare(right.course, 'zh-CN'))
        .map((assessment, assessmentIndex) => ({
          id: `${participantId}-assessment-${assessmentIndex + 1}`,
          ...assessment,
        }));
      const scores = assessments
        .filter(({ status }) => status === 'passed' || status === 'failed')
        .map(({ score }) => score)
        .filter((score): score is number => score !== null);
      return {
        id: participantId,
        name: participant.name,
        building: participant.building,
        totalCourses: assessments.length,
        passedCourses: countStatus(assessments, 'passed'),
        failedCourses: countStatus(assessments, 'failed'),
        pendingCourses: countStatus(assessments, 'pending'),
        absentCourses: countStatus(assessments, 'absent'),
        averageScore:
          scores.length === 0
            ? null
            : roundOne(
                scores.reduce((total, value) => total + value, 0) /
                  scores.length,
              ),
        assessments,
      };
    });
}

function chooseAssessment(
  current: MutableAssessment | undefined,
  candidate: MutableAssessment,
): MutableAssessment {
  if (!current) return candidate;
  if (candidate.signedIn === false && current.signedIn !== false) {
    return candidate;
  }
  if (current.signedIn === false) return current;
  if (candidate.score !== null && current.score === null) return candidate;
  if (candidate.signedIn === true && current.signedIn === null)
    return candidate;
  return current;
}

function countStatus(
  assessments: TrainingAssessmentDetail[],
  status: TrainingAssessmentStatus,
): number {
  return assessments.filter((assessment) => assessment.status === status)
    .length;
}

function assessmentStatus(
  score: number | null,
  signedIn: boolean | null,
  passScore: number,
): TrainingAssessmentStatus {
  if (signedIn === false) return 'absent';
  if (score === null || signedIn !== true) return 'pending';
  return score >= passScore ? 'passed' : 'failed';
}

function mapRelevantSharingSessions(
  records: BitableRecordItem[],
  selectedMonth: string,
): TrainingSharingSessionDetail[] {
  const yearHint = selectedMonth.slice(0, 4);
  const sessions = records.flatMap((record): MutableSharingSession[] => {
    const fields = record.fields || {};
    const topic = asText(fields['分享主题']);
    const startTimestamp = asBusinessTimestamp(fields['开始时间']);
    const endTimestamp = asBusinessTimestamp(fields['结束时间']);
    const rawMonth = normalizeMonth(fields['月度'], yearHint);
    const month =
      (startTimestamp === null
        ? null
        : formatShanghaiMonth(new Date(startTimestamp))) || rawMonth;
    if (!topic || !month) return [];

    const status = normalizeSharingStatus(asText(fields['会议进度（勿动）']));
    const startedAt =
      startTimestamp === null ? null : new Date(startTimestamp).toISOString();
    const endedAt =
      endTimestamp === null ? null : new Date(endTimestamp).toISOString();
    return [
      {
        month,
        topic,
        category: asText(fields['分享类型']) || '未分类',
        status,
        startedAt,
        endedAt,
        presenterNames: uniqueNames(
          extractPeople(fields['分享人']).map(({ name }) => name),
        ),
        participantCount: uniqueNames(
          extractPeople(fields['参会人 (人员 )']).map(({ name }) => name),
        ).length,
        buildings: sortBuildings(
          uniqueNames(
            extractTexts(fields['楼栋&专业（多选）'])
              .flatMap(splitVisibleLabels)
              .map(normalizeBuilding)
              .filter(Boolean),
          ),
        ),
        durationHours:
          startTimestamp !== null &&
          endTimestamp !== null &&
          endTimestamp > startTimestamp
            ? roundOne((endTimestamp - startTimestamp) / HOUR_MS)
            : 0,
        hasMaterial:
          Boolean(asText(fields['演示文档/PPT（链接）'])) ||
          Boolean(asText(fields['会议回放&妙记链接'])),
        scheduled:
          startTimestamp !== null || endTimestamp !== null || rawMonth !== null,
      },
    ];
  });

  return sessions
    .filter(
      (session) =>
        (session.status === '已结束' &&
          session.month.localeCompare(selectedMonth) <= 0) ||
        (session.month === selectedMonth &&
          session.scheduled &&
          session.status !== '已终止'),
    )
    .sort(
      (left, right) =>
        left.month.localeCompare(right.month) ||
        (left.startedAt ?? '').localeCompare(right.startedAt ?? '') ||
        left.topic.localeCompare(right.topic, 'zh-CN'),
    )
    .map(({ scheduled: _scheduled, ...session }, index) => ({
      id: `sharing-session-${index + 1}`,
      ...session,
    }));
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

function resolvePlanMonth(fields: Record<string, unknown>): string | null {
  const year = asText(fields['培训年份']).match(/(?:20)\d{2}/)?.[0] ?? null;
  return normalizeMonth(fields['培训月份'], year);
}

function resolveScoreMonth(
  fields: Record<string, unknown>,
  selectedMonth: string,
): string | null {
  const primary = parseMonth(fields['月份']);
  const planned = parseMonth(fields['月份（计划）']);
  if (planned?.year) return `${planned.year}-${planned.month}`;
  if (primary?.year) return `${primary.year}-${primary.month}`;
  const year =
    asText(fields['年份']).match(/(?:20)\d{2}/)?.[0] ??
    asText(fields['培训年份']).match(/(?:20)\d{2}/)?.[0] ??
    asText(fields['年度']).match(/(?:20)\d{2}/)?.[0] ??
    selectedMonth.slice(0, 4);
  const month = primary?.month || planned?.month;
  return year && month ? `${year}-${month}` : null;
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
  const monthOnly = text.match(/^(1[0-2]|0?[1-9])(?:\s*月)?$/);
  if (monthOnly) {
    return { year: null, month: monthOnly[1].padStart(2, '0') };
  }
  const full = text.match(
    /((?:20)\d{2})\s*(?:年|[-/.])\s*(1[0-2]|0?[1-9])(?:\s*月)?/,
  );
  if (!full) return null;
  const year = Number(full[1]);
  if (year < MIN_BUSINESS_YEAR || year > MAX_BUSINESS_YEAR) return null;
  return { year: full[1], month: full[2].padStart(2, '0') };
}

function extractPeople(value: unknown): PersonIdentity[] {
  if (!hasValue(value)) return [];
  if (Array.isArray(value)) {
    return deduplicatePeople(value.flatMap(extractPeople));
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const name = String(value).trim();
    return isVisiblePersonName(name)
      ? [{ key: `name:${normalizePersonName(name)}`, name }]
      : [];
  }
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  for (const key of ['users', 'select']) {
    if (hasValue(object[key])) return extractPeople(object[key]);
  }
  const name = asText(
    object.name ??
      object.user_name ??
      object.text ??
      object.label ??
      object.title,
  );
  const stableId = asText(
    object.id ?? object.open_id ?? object.user_id ?? object.union_id,
  );
  if (isVisiblePersonName(name)) {
    return [
      {
        key: stableId ? `id:${stableId}` : `name:${normalizePersonName(name)}`,
        name,
      },
    ];
  }
  if (hasValue(object.value)) return extractPeople(object.value);
  return [];
}

function deduplicatePeople(people: PersonIdentity[]): PersonIdentity[] {
  const result = new Map<string, PersonIdentity>();
  for (const person of people) {
    if (!result.has(person.key)) result.set(person.key, person);
  }
  return [...result.values()];
}

function isVisiblePersonName(name: string): boolean {
  const normalized = normalizePersonName(name);
  return (
    normalized.length > 0 &&
    !/^(?:-|--|—|－|_|无|暂无|待定|null|undefined)$/i.test(normalized)
  );
}

function normalizePersonName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

function extractTexts(value: unknown): string[] {
  if (!hasValue(value)) return [];
  if (Array.isArray(value)) return value.flatMap(extractTexts);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    const text = String(value).trim();
    return text ? [text] : [];
  }
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  for (const key of [
    'value',
    'name',
    'text',
    'label',
    'title',
    'user_name',
    'link',
    'url',
    'href',
  ]) {
    if (hasValue(object[key])) return extractTexts(object[key]);
  }
  return [];
}

function asText(value: unknown): string {
  return extractTexts(value)[0] ?? '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  for (const text of extractTexts(value)) {
    const parsed = Number(text.replace(/[%％,\s]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  for (const item of extractTexts(value)) {
    if (/^(?:true|是|已签到|签到)$/i.test(item)) return true;
    if (/^(?:false|否|未签到|缺席)$/i.test(item)) return false;
  }
  return null;
}

function asBusinessDate(value: unknown): string | null {
  const timestamp = asBusinessTimestamp(value);
  return timestamp === null
    ? parsePlainBusinessDate(value)
    : formatShanghaiDate(new Date(timestamp));
}

function asBusinessTimestamp(value: unknown): number | null {
  if (!hasValue(value)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const timestamp = asBusinessTimestamp(item);
      if (timestamp !== null) return timestamp;
    }
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value >= 20_000 && value <= 80_000) {
      const excelDate = new Date(EXCEL_EPOCH_MS + value * DAY_MS);
      return isBusinessDate(excelDate) ? excelDate.getTime() : null;
    }
    const timestamp =
      Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(timestamp);
    return isBusinessDate(date) ? timestamp : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^\d{5}(?:\.\d+)?$/.test(text)) {
      return asBusinessTimestamp(Number(text));
    }
    if (/^-?\d{10,13}$/.test(text)) {
      return asBusinessTimestamp(Number(text));
    }
    const date = new Date(
      text.replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-'),
    );
    return isBusinessDate(date) ? date.getTime() : null;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'value', 'text']) {
      const timestamp = asBusinessTimestamp(object[key]);
      if (timestamp !== null) return timestamp;
    }
  }
  return null;
}

function parsePlainBusinessDate(value: unknown): string | null {
  const text = asText(value);
  const match = text
    .replace(/年|月/g, '-')
    .replace(/日/g, '')
    .replace(/\//g, '-')
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < MIN_BUSINESS_YEAR ||
    year > MAX_BUSINESS_YEAR ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatShanghaiDate(date: Date): string | null {
  if (!isBusinessDate(date)) return null;
  const parts = shanghaiParts(date, true);
  return parts.day ? `${parts.year}-${parts.month}-${parts.day}` : null;
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
    year: values.year,
    month: values.month,
    ...(includeDay ? { day: values.day } : {}),
  };
}

function isBusinessDate(date: Date): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const year = Number(shanghaiParts(date, false).year);
  return year >= MIN_BUSINESS_YEAR && year <= MAX_BUSINESS_YEAR;
}

function normalizeBuilding(value: unknown): string {
  const text = asText(value).trim().toUpperCase();
  const match = text.match(/(?:^|[^A-Z])([ABCDEH])\s*(?:楼|栋)?(?:$|[^A-Z])/);
  return match?.[1] ? `${match[1]}楼` : text;
}

function splitVisibleLabels(value: string): string[] {
  return value
    .split(/[,，、;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sortBuildings(buildings: string[]): string[] {
  return [...buildings].sort(
    (left, right) =>
      buildingRank(left) - buildingRank(right) ||
      left.localeCompare(right, 'zh-CN'),
  );
}

function buildingRank(building: string): number {
  const index = BUILDING_ORDER.indexOf(building);
  return index < 0 ? BUILDING_ORDER.length : index;
}

function uniqueNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizePassScore(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : DEFAULT_PASS_SCORE;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasValue);
  }
  return false;
}
