import type {
  PersonnelTimeInsightsBuildingSummary,
  PersonnelTimeInsightsLeaveDetail,
  PersonnelTimeInsightsMetrics,
  PersonnelTimeInsightsMonthlyPoint,
  PersonnelTimeInsightsOvertimeDetail,
  PersonnelTimeInsightsPersonSummary,
  PersonnelTimeInsightsResponse,
} from '@shared/personnel-time-insights.interface';
import type { LeaveWorkflowApplicationEntry } from '../leave-workflow/leave-workflow.store';
import type {
  OvertimeWorkflowApplicationEntry,
  OvertimeWorkflowConfirmationEntry,
} from '../overtime-workflow/overtime-workflow.store';

interface BuildPersonnelTimeInsightsInput {
  from: string;
  through: string;
  overtimeApplications: OvertimeWorkflowApplicationEntry[];
  overtimeConfirmations: OvertimeWorkflowConfirmationEntry[];
  leaveApplications: LeaveWorkflowApplicationEntry[];
}

interface MutablePerson extends PersonnelTimeInsightsPersonSummary {
  officialActivity: boolean;
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const BUILDING_ORDER = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'];

export function buildPersonnelTimeInsights(
  input: BuildPersonnelTimeInsightsInput,
): PersonnelTimeInsightsResponse {
  assertDateRange(input.from, input.through);
  const people = new Map<string, MutablePerson>();
  const months = createMonths(input.from, input.through);
  const quality = {
    legacyDefaultedCompensatoryCount: 0,
    legacyLeaveStartDateCount: 0,
  };
  const confirmationByRecordId = new Map(
    input.overtimeConfirmations.map((entry) => [entry.recordId, entry]),
  );
  const pendingPeople = new Set<string>();
  let pendingCount = 0;

  for (const application of input.overtimeApplications) {
    if (application.phase === 'awaiting_confirmation') {
      const date = dateKeyOf(application.snapshot.plannedStartAt);
      if (!date || !isWithin(date, input.from, input.through)) continue;
      const person = getOrCreatePerson(people, {
        name: application.snapshot.applicantName,
        openId: application.snapshot.applicantOpenId,
        building: application.snapshot.building,
        position: application.snapshot.position,
      });
      person.pendingOvertimeCount += 1;
      person.details.pendingOvertime!.push({
        recordId: application.recordId,
        startAt: application.snapshot.plannedStartAt,
        endAt: application.snapshot.plannedEndAt,
        hours: normalizeHours(application.snapshot.plannedHours),
      });
      pendingCount += 1;
      if (person.name) pendingPeople.add(person.name);
      continue;
    }
    if (application.phase !== 'confirmed') continue;
    const confirmation = confirmationByRecordId.get(application.recordId);
    if (!confirmation) continue;
    const date = dateKeyOf(confirmation.draft.actualStartAt);
    if (!date || !isWithin(date, input.from, input.through)) continue;
    const hours = normalizeHours(confirmation.draft.actualHours);
    if (hours <= 0) continue;
    const person = getOrCreatePerson(people, {
      name: application.snapshot.applicantName,
      openId: application.snapshot.applicantOpenId,
      building: application.snapshot.building,
      position: application.snapshot.position,
    });
    const legacyDefaultedDisposition = !confirmation.draft.disposition;
    const disposition = confirmation.draft.disposition || '调休';
    if (legacyDefaultedDisposition) {
      quality.legacyDefaultedCompensatoryCount += 1;
    }
    person.officialActivity = true;
    person.overtimeHours = add(person.overtimeHours, hours);
    if (disposition === '加班费') {
      person.overtimePayHours = add(person.overtimePayHours, hours);
    } else if (disposition === '费用结算') {
      person.feeSettlementHours = add(person.feeSettlementHours, hours);
    } else {
      person.compensatoryAccruedHours = add(
        person.compensatoryAccruedHours,
        hours,
      );
    }
    person.details.overtime.push({
      recordId: application.recordId,
      startAt: confirmation.draft.actualStartAt,
      endAt:
        confirmation.draft.actualEndAt ||
        overtimeEndAt(confirmation.draft.actualStartAt, hours),
      hours,
      disposition,
      legacyDefaultedDisposition,
    });
    const monthly = months.get(date.slice(0, 7));
    if (monthly) {
      monthly.overtimeHours = add(monthly.overtimeHours, hours);
      if (disposition === '调休') {
        monthly.compensatoryAccruedHours = add(
          monthly.compensatoryAccruedHours,
          hours,
        );
      }
    }
  }

  for (const application of input.leaveApplications) {
    if (application.status !== 'approved') continue;
    const snapshot = application.snapshot;
    const person = getOrCreatePerson(people, {
      name: snapshot.applicantName,
      openId: snapshot.applicantOpenId,
      building: snapshot.building,
      position: snapshot.position,
    });
    const groups = Array.isArray(snapshot.shiftGroups)
      ? snapshot.shiftGroups.filter(
          (group) =>
            DATE_KEY_PATTERN.test(group.scheduleDate) &&
            isWithin(group.scheduleDate, input.from, input.through),
        )
      : [];
    const details: PersonnelTimeInsightsLeaveDetail[] = groups.map((group) => ({
      recordId: application.recordId,
      date: group.scheduleDate,
      startAt: group.startAt,
      endAt: group.endAt,
      hours: normalizeHours(group.leaveHours),
      leaveType: snapshot.leaveType,
      travel: snapshot.leaveType === '差旅',
      legacyStartDateFallback: false,
    }));
    if (details.length === 0 && !snapshot.shiftGroups?.length) {
      const fallbackDate = dateKeyOf(snapshot.startAt);
      if (fallbackDate && isWithin(fallbackDate, input.from, input.through)) {
        quality.legacyLeaveStartDateCount += 1;
        details.push({
          recordId: application.recordId,
          date: fallbackDate,
          startAt: snapshot.startAt,
          endAt: snapshot.endAt,
          hours: normalizeHours(snapshot.leaveHours),
          leaveType: snapshot.leaveType,
          travel: snapshot.leaveType === '差旅',
          legacyStartDateFallback: true,
        });
      }
    }
    for (const detail of details) {
      if (detail.hours <= 0) continue;
      person.officialActivity = true;
      person.details.leave.push(detail);
      const monthly = months.get(detail.date.slice(0, 7));
      if (detail.travel) {
        person.travelHours = add(person.travelHours, detail.hours);
        if (monthly)
          monthly.travelHours = add(monthly.travelHours, detail.hours);
        continue;
      }
      person.leaveHours = add(person.leaveHours, detail.hours);
      if (monthly) monthly.leaveHours = add(monthly.leaveHours, detail.hours);
      if (snapshot.leaveType === '调休') {
        person.compensatoryUsedHours = add(
          person.compensatoryUsedHours,
          detail.hours,
        );
        if (monthly) {
          monthly.compensatoryUsedHours = add(
            monthly.compensatoryUsedHours,
            detail.hours,
          );
        }
      }
    }
  }

  const peopleResult = [...people.values()]
    .map(finalizePerson)
    .filter(
      (person) =>
        person.overtimeHours > 0 ||
        person.leaveHours > 0 ||
        person.travelHours > 0 ||
        person.pendingOvertimeCount > 0,
    )
    .sort(comparePeople);
  const buildings = buildBuildings(peopleResult);
  const metrics = sumMetrics(
    peopleResult.filter((person) => hasOfficialActivity(person)),
  );
  metrics.overtimePeople = peopleResult.filter(
    (person) => person.overtimeHours > 0,
  ).length;

  return {
    range: { from: input.from, through: input.through },
    metrics,
    monthly: [...months.values()],
    buildings,
    people: peopleResult,
    pendingOvertime: {
      count: pendingCount,
      people: [...pendingPeople].sort(compareText),
    },
    quality,
  };
}

export function assertDateRange(from: string, through: string): void {
  if (!isValidDateKey(from) || !isValidDateKey(through) || from > through) {
    throw new Error('统计日期范围无效');
  }
  const fromDate = new Date(`${from}T00:00:00Z`);
  const throughDate = new Date(`${through}T00:00:00Z`);
  const days = (throughDate.getTime() - fromDate.getTime()) / 86_400_000;
  if (days > 366 * 5) throw new Error('统计日期范围不能超过五年');
}

function getOrCreatePerson(
  people: Map<string, MutablePerson>,
  identity: {
    name: string;
    openId: string;
    building: string;
    position: string;
  },
): MutablePerson {
  const name = clean(identity.name) || '未知人员';
  const building = clean(identity.building) || '未分组';
  const openId = clean(identity.openId);
  const key = openId || `${name}\u0000${building}`;
  const existing = people.get(key);
  if (existing) return existing;
  const result: MutablePerson = {
    key,
    name,
    openId: openId || null,
    building,
    position: clean(identity.position) || '未配置岗位',
    ...emptyMetrics(),
    pendingOvertimeCount: 0,
    details: { overtime: [], leave: [], pendingOvertime: [] },
    officialActivity: false,
  };
  people.set(key, result);
  return result;
}

function finalizePerson(
  person: MutablePerson,
): PersonnelTimeInsightsPersonSummary {
  const result = { ...person };
  result.compensatoryAvailableHours = add(
    result.compensatoryAccruedHours,
    -result.compensatoryUsedHours,
  );
  result.details = {
    overtime: [...result.details.overtime].sort((left, right) =>
      left.startAt.localeCompare(right.startAt),
    ),
    leave: [...result.details.leave].sort((left, right) =>
      left.startAt.localeCompare(right.startAt),
    ),
    pendingOvertime: [...(result.details.pendingOvertime || [])].sort(
      (left, right) => left.startAt.localeCompare(right.startAt),
    ),
  };
  delete (result as Partial<MutablePerson>).officialActivity;
  return result;
}

function overtimeEndAt(startAt: string, hours: number): string {
  const start = Date.parse(`${startAt.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(start)) return '';
  return new Date(start + hours * 3_600_000 + 8 * 3_600_000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

function buildBuildings(
  people: PersonnelTimeInsightsPersonSummary[],
): PersonnelTimeInsightsBuildingSummary[] {
  const byBuilding = new Map<string, PersonnelTimeInsightsPersonSummary[]>();
  for (const person of people) {
    const list = byBuilding.get(person.building) || [];
    list.push(person);
    byBuilding.set(person.building, list);
  }
  return [...byBuilding.entries()]
    .map(([building, entries]) => ({
      building,
      peopleCount: entries.length,
      pendingOvertimeCount: entries.reduce(
        (sum, entry) => sum + entry.pendingOvertimeCount,
        0,
      ),
      ...sumMetrics(entries),
    }))
    .sort((left, right) => compareBuildings(left.building, right.building));
}

function sumMetrics(
  people: PersonnelTimeInsightsPersonSummary[],
): PersonnelTimeInsightsMetrics {
  const result = emptyMetrics();
  for (const person of people) {
    result.overtimeHours = add(result.overtimeHours, person.overtimeHours);
    result.overtimePayHours = add(
      result.overtimePayHours,
      person.overtimePayHours,
    );
    result.feeSettlementHours = add(
      result.feeSettlementHours,
      person.feeSettlementHours,
    );
    result.compensatoryAccruedHours = add(
      result.compensatoryAccruedHours,
      person.compensatoryAccruedHours,
    );
    result.compensatoryUsedHours = add(
      result.compensatoryUsedHours,
      person.compensatoryUsedHours,
    );
    result.leaveHours = add(result.leaveHours, person.leaveHours);
    result.travelHours = add(result.travelHours, person.travelHours);
  }
  result.compensatoryAvailableHours = add(
    result.compensatoryAccruedHours,
    -result.compensatoryUsedHours,
  );
  result.overtimePeople = people.filter(
    (person) => person.overtimeHours > 0,
  ).length;
  return result;
}

function emptyMetrics(): PersonnelTimeInsightsMetrics {
  return {
    overtimePeople: 0,
    overtimeHours: 0,
    overtimePayHours: 0,
    feeSettlementHours: 0,
    compensatoryAccruedHours: 0,
    compensatoryUsedHours: 0,
    compensatoryAvailableHours: 0,
    leaveHours: 0,
    travelHours: 0,
  };
}

function createMonths(
  from: string,
  through: string,
): Map<string, PersonnelTimeInsightsMonthlyPoint> {
  const result = new Map<string, PersonnelTimeInsightsMonthlyPoint>();
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const throughMonth = through.slice(0, 7);
  while (true) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    result.set(key, {
      month: key,
      overtimeHours: 0,
      leaveHours: 0,
      travelHours: 0,
      compensatoryAccruedHours: 0,
      compensatoryUsedHours: 0,
    });
    if (key === throughMonth) break;
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return result;
}

function isValidDateKey(value: string): boolean {
  if (!DATE_KEY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function dateKeyOf(value: string): string | null {
  const match = clean(value).match(/^(\d{4}-\d{2}-\d{2})/u);
  return match && isValidDateKey(match[1]) ? match[1] : null;
}

function isWithin(value: string, from: string, through: string): boolean {
  return value >= from && value <= through;
}

function normalizeHours(value: unknown): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number > 0 ? roundHours(number) : 0;
}

function add(left: number, right: number): number {
  return roundHours(left + right);
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function comparePeople(
  left: PersonnelTimeInsightsPersonSummary,
  right: PersonnelTimeInsightsPersonSummary,
): number {
  return (
    compareBuildings(left.building, right.building) ||
    right.overtimeHours - left.overtimeHours ||
    compareText(left.name, right.name)
  );
}

function compareBuildings(left: string, right: string): number {
  const leftIndex = BUILDING_ORDER.indexOf(left);
  const rightIndex = BUILDING_ORDER.indexOf(right);
  if (leftIndex >= 0 || rightIndex >= 0) {
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  }
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN');
}

function hasOfficialActivity(
  person: PersonnelTimeInsightsPersonSummary,
): boolean {
  return (
    person.overtimeHours > 0 || person.leaveHours > 0 || person.travelHours > 0
  );
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
