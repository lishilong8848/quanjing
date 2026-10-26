import type {
  LongWhiteDutyStaffByBuilding,
  MonthlySchedule,
} from '@shared/api.interface';
import type { AttendanceAutomationTask } from './attendance-automation.scheduler';
import type {
  AttendanceDirection,
  AttendanceExpectation,
  DingTalkAttendanceResult,
} from './attendance-automation.rules';
import type {
  DingTalkAttendanceRawDetail,
  DingTalkAttendanceRawResult,
  DingTalkDirectoryUser,
} from './dingtalk-attendance.client';

export interface AttendanceExpectationPlan {
  expectations: AttendanceExpectation[];
  excludedCount: number;
}

export interface BuildAttendanceExpectationPlanInput {
  task: Exclude<AttendanceAutomationTask, 'archive-yesterday'>;
  date: string;
  schedules: readonly MonthlySchedule[];
  longWhiteBuildings: readonly LongWhiteDutyStaffByBuilding[];
  preciseLeave?: boolean;
}

interface ScheduleRule {
  date: string;
  buildings: 'campus' | 'station';
  shift: 'white' | 'night';
  direction: AttendanceDirection;
  expectedTime: string;
}

const CAMPUS_BUILDINGS = new Set([
  'building_a',
  'building_b',
  'building_c',
  'building_d',
  'building_e',
  'building_h',
]);

const BUILDING_LABELS: Record<string, string> = {
  building_a: 'A楼',
  building_b: 'B楼',
  building_c: 'C楼',
  building_d: 'D楼',
  building_e: 'E楼',
  building_h: 'H楼',
  station_110: '110站',
};

export function buildAttendanceExpectationPlan(
  input: BuildAttendanceExpectationPlanInput,
): AttendanceExpectationPlan {
  assertDateKey(input.date);
  const schedulePlan = buildScheduleExpectationPlan(
    input.date,
    input.schedules,
    buildScheduleRules(input.task, input.date),
    input.preciseLeave,
  );
  const expectations = schedulePlan.expectations;

  if (
    input.task === 'morning-on-duty-reminder' ||
    input.task === 'evening-off-duty-check'
  ) {
    const direction: AttendanceDirection =
      input.task === 'evening-off-duty-check' ? 'OffDuty' : 'OnDuty';
    const expectedTime =
      input.task === 'evening-off-duty-check' ? '18:00:00' : '09:00:00';
    input.longWhiteBuildings.forEach((building) => {
      if (!CAMPUS_BUILDINGS.has(building.building)) return;
      building.staff.forEach((name) => {
        const normalizedName = normalizeName(name);
        if (!normalizedName) return;
        expectations.push({
          key: buildExpectationKey(
            input.date,
            building.building,
            'long_white',
            direction,
            normalizedName,
          ),
          name: name.trim(),
          building:
            BUILDING_LABELS[building.building] ||
            building.buildingName ||
            building.building,
          shiftLabel: '长白班',
          direction,
          expectedAt: `${input.date} ${expectedTime}`,
          status: building.substituteStaff?.some(
            (name) => normalizeName(name) === normalizedName,
          )
            ? 'substitute'
            : 'on_duty',
        });
      });
    });
  }

  return {
    expectations: dedupeExpectations(expectations),
    excludedCount: schedulePlan.excludedCount,
  };
}

export function buildFinalAttendanceExpectationPlan(
  input: BuildAttendanceExpectationPlanInput & {
    task: 'morning-off-duty-check' | 'evening-off-duty-check';
  },
): AttendanceExpectationPlan {
  const tasks =
    input.task === 'morning-off-duty-check'
      ? (['morning-on-duty-reminder', 'morning-off-duty-check'] as const)
      : (['evening-on-duty-reminder', 'evening-off-duty-check'] as const);
  const plans = tasks.map((task) =>
    buildAttendanceExpectationPlan({ ...input, task }),
  );
  return {
    expectations: dedupeExpectations(
      plans.flatMap((plan) => plan.expectations),
    ),
    excludedCount: plans.reduce((total, plan) => total + plan.excludedCount, 0),
  };
}

export function buildDailyAttendanceExpectationPlan(
  input: Omit<BuildAttendanceExpectationPlanInput, 'task'>,
): AttendanceExpectationPlan {
  const plans = (
    [
      'morning-on-duty-reminder',
      'morning-off-duty-check',
      'evening-on-duty-reminder',
      'evening-off-duty-check',
    ] as const
  ).map((task) => buildAttendanceExpectationPlan({ ...input, task }));
  const stationNightOnDuty = buildScheduleExpectationPlan(
    input.date,
    input.schedules,
    [
      {
        date: input.date,
        buildings: 'station',
        shift: 'night',
        direction: 'OnDuty',
        expectedTime: '20:00:00',
      },
    ],
    input.preciseLeave,
  );
  const stationWhiteOffDuty = buildScheduleExpectationPlan(
    input.date,
    input.schedules,
    [
      {
        date: input.date,
        buildings: 'station',
        shift: 'white',
        direction: 'OffDuty',
        expectedTime: '20:00:00',
      },
    ],
    input.preciseLeave,
  );
  const archivePlans = [...plans, stationNightOnDuty, stationWhiteOffDuty];
  return {
    expectations: dedupeExpectations(
      archivePlans.flatMap((plan) => plan.expectations),
    ),
    excludedCount: archivePlans.reduce(
      (total, plan) => total + plan.excludedCount,
      0,
    ),
  };
}

function buildScheduleExpectationPlan(
  businessDate: string,
  schedules: readonly MonthlySchedule[],
  rules: readonly ScheduleRule[],
  preciseLeave = false,
): AttendanceExpectationPlan {
  const expectations: AttendanceExpectation[] = [];
  const excludedNames = new Set<string>();

  for (const rule of rules) {
    for (const schedule of schedules) {
      if (
        schedule.scheduleDate !== rule.date ||
        schedule.shift !== rule.shift ||
        schedule.team === 'long_white' ||
        !matchesBuildingScope(schedule.building, rule.buildings)
      ) {
        continue;
      }

      const leaveNames = new Set(
        schedule.leaveStaff.map(normalizeName).filter(Boolean),
      );
      const travelNames = new Set(
        (schedule.travelStaff || []).map(normalizeName).filter(Boolean),
      );
      [...schedule.leaveStaff, ...(schedule.travelStaff || [])].forEach(
        (name) => {
          const normalized = normalizeName(name);
          if (normalized)
            excludedNames.add(`${schedule.recordId}:${normalized}`);
        },
      );
      [
        ...schedule.dutyStaffActual,
        ...schedule.substituteStaff,
        ...(preciseLeave ? schedule.leaveStaff : []),
      ].forEach((name) => {
        const normalizedName = normalizeName(name);
        if (
          !normalizedName ||
          (!preciseLeave && leaveNames.has(normalizedName)) ||
          travelNames.has(normalizedName)
        ) {
          return;
        }
        const isSubstitute = schedule.substituteStaff.some(
          (candidate) => normalizeName(candidate) === normalizedName,
        );
        const isPlanned = schedule.dutyStaffReference.some(
          (candidate) => normalizeName(candidate) === normalizedName,
        );
        expectations.push({
          key: buildExpectationKey(
            businessDate,
            schedule.building,
            schedule.shift,
            rule.direction,
            normalizedName,
          ),
          name: name.trim(),
          building:
            BUILDING_LABELS[schedule.building] ||
            schedule.buildingText ||
            schedule.building,
          shiftLabel: schedule.shift === 'night' ? '夜班' : '白班',
          direction: rule.direction,
          expectedAt: `${businessDate} ${rule.expectedTime}`,
          status: isSubstitute
            ? 'substitute'
            : isPlanned
              ? 'on_duty'
              : 'vacancy_substitute',
        });
      });
    }
  }

  return {
    expectations: dedupeExpectations(expectations),
    excludedCount: excludedNames.size,
  };
}

export function matchDingTalkResultsToExpectations(
  expectations: readonly AttendanceExpectation[],
  users: readonly DingTalkDirectoryUser[],
  records: readonly DingTalkAttendanceRawResult[],
  details: readonly DingTalkAttendanceRawDetail[] = [],
): DingTalkAttendanceResult[] {
  const userIdsByName = new Map<string, Set<string>>();
  users.forEach((user) => {
    const name = normalizeName(user.name);
    if (!name || !user.userId) return;
    const ids = userIdsByName.get(name) || new Set<string>();
    ids.add(user.userId);
    userIdsByName.set(name, ids);
  });

  const matched: DingTalkAttendanceResult[] = [];
  expectations.forEach((expectation) => {
    const userIds = userIdsByName.get(normalizeName(expectation.name));
    if (!userIds?.size) return;
    const expectedMillis = parseShanghaiLocalDateTime(expectation.expectedAt);
    const candidates = records
      .filter(
        (record) =>
          userIds.has(record.userId) &&
          record.checkType === expectation.direction &&
          Math.abs(toEpochMillis(record.baseCheckTime) - expectedMillis) <=
            90 * 60 * 1000,
      )
      .sort(
        (left, right) =>
          Math.abs(toEpochMillis(left.baseCheckTime) - expectedMillis) -
          Math.abs(toEpochMillis(right.baseCheckTime) - expectedMillis),
      );
    const candidate = candidates[0];
    const detail = details
      .filter((item) => {
        const comparisonTime = item.baseCheckTime ?? item.userCheckTime;
        return (
          userIds.has(item.userId) &&
          item.checkType === expectation.direction &&
          item.userCheckTime !== null &&
          Math.abs(toEpochMillis(comparisonTime) - expectedMillis) <=
            3 * 60 * 60 * 1000
        );
      })
      .sort(
        (left, right) =>
          Math.abs(
            toEpochMillis(left.baseCheckTime ?? left.userCheckTime) -
              expectedMillis,
          ) -
          Math.abs(
            toEpochMillis(right.baseCheckTime ?? right.userCheckTime) -
              expectedMillis,
          ),
      )[0];
    const preferDetail = Boolean(
      candidate &&
      !candidate.userCheckTime &&
      (!candidate.timeResult ||
        ['NotSigned', 'Absenteeism'].includes(candidate.timeResult)) &&
      detail &&
      !detail.invalidRecordMsg,
    );
    if (candidate && !preferDetail) {
      matched.push({
        expectationKey: expectation.key,
        timeResult:
          expectation.status === 'overtime' && candidate.userCheckTime
            ? inferTimeResultFromPunch(
                expectation.direction,
                candidate.userCheckTime,
                expectedMillis,
              )
            : candidate.timeResult || null,
        userCheckTime: formatRecordTime(candidate.userCheckTime),
        userId: candidate.userId,
        baseCheckTime: candidate.baseCheckTime,
        sourceType: candidate.sourceType,
        correctionEvidenceStatus: candidate.correctionEvidenceStatus,
      });
      return;
    }
    if (detail) {
      matched.push({
        expectationKey: expectation.key,
        timeResult:
          (expectation.status !== 'overtime' ? detail.timeResult : null) ||
          inferTimeResultFromPunch(
            expectation.direction,
            detail.userCheckTime,
            expectedMillis,
          ),
        userCheckTime: formatRecordTime(detail.userCheckTime),
        userId: detail.userId,
        baseCheckTime: detail.baseCheckTime,
        sourceType: detail.sourceType,
      });
    }
  });
  return matched;
}

function inferTimeResultFromPunch(
  direction: AttendanceDirection,
  userCheckTime: number | string | null,
  expectedMillis: number,
): 'Normal' | 'Late' | 'EarlyLeave' {
  const actualMillis = toEpochMillis(userCheckTime);
  if (direction === 'OnDuty' && actualMillis > expectedMillis) return 'Late';
  if (direction === 'OffDuty' && actualMillis < expectedMillis) {
    return 'EarlyLeave';
  }
  return 'Normal';
}

function buildScheduleRules(
  task: Exclude<AttendanceAutomationTask, 'archive-yesterday'>,
  date: string,
): ScheduleRule[] {
  const previousDate = shiftDate(date, -1);
  switch (task) {
    case 'morning-on-duty-reminder':
      return [
        {
          date,
          buildings: 'campus',
          shift: 'white',
          direction: 'OnDuty',
          expectedTime: '09:00:00',
        },
        {
          date,
          buildings: 'station',
          shift: 'white',
          direction: 'OnDuty',
          expectedTime: '08:00:00',
        },
      ];
    case 'morning-off-duty-check':
      return [
        {
          date: previousDate,
          buildings: 'campus',
          shift: 'night',
          direction: 'OffDuty',
          expectedTime: '09:00:00',
        },
        {
          date: previousDate,
          buildings: 'station',
          shift: 'night',
          direction: 'OffDuty',
          expectedTime: '08:00:00',
        },
      ];
    case 'evening-on-duty-reminder':
      return [
        {
          date,
          buildings: 'campus',
          shift: 'night',
          direction: 'OnDuty',
          expectedTime: '18:00:00',
        },
      ];
    case 'evening-off-duty-check':
      return [
        {
          date,
          buildings: 'campus',
          shift: 'white',
          direction: 'OffDuty',
          expectedTime: '18:00:00',
        },
      ];
  }
}

function matchesBuildingScope(
  building: string,
  scope: ScheduleRule['buildings'],
): boolean {
  return scope === 'station'
    ? building === 'station_110'
    : CAMPUS_BUILDINGS.has(building);
}

function buildExpectationKey(
  date: string,
  building: string,
  shift: string,
  direction: AttendanceDirection,
  name: string,
): string {
  return [date, building, shift, direction, name].join(':');
}

function dedupeExpectations(
  expectations: AttendanceExpectation[],
): AttendanceExpectation[] {
  return [...new Map(expectations.map((item) => [item.key, item])).values()];
}

function normalizeName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '');
}

function shiftDate(date: string, offsetDays: number): string {
  const [year, month, day] = assertDateKey(date);
  return new Date(Date.UTC(year, month - 1, day + offsetDays))
    .toISOString()
    .slice(0, 10);
}

function assertDateKey(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`无效业务日期：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseShanghaiLocalDateTime(value: string): number {
  const parsed = Date.parse(value.replace(' ', 'T') + '+08:00');
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toEpochMillis(value: number | string | null): number {
  if (typeof value === 'number') return value;
  if (!value) return Number.NaN;
  if (/^\d+$/.test(value)) return Number(value);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return Date.parse(hasZone ? value : value.replace(' ', 'T') + '+08:00');
}

function formatRecordTime(value: number | string | null): string | null {
  if (value === null || value === '') return null;
  const millis = toEpochMillis(value);
  if (!Number.isFinite(millis)) return String(value);
  const local = new Date(millis + 8 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 10)} ${local
    .toISOString()
    .slice(11, 19)}`;
}
