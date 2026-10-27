import {
  calculateLeaveRequestImpact,
  calculateLeaveRequestSubstituteRule,
  createLeaveRequestTimeCandidates,
  createLeaveRequestImpactComparisonKey,
  isLeaveSubstituteStaffBlocked,
  parseShanghaiLocalDateTime,
  resolveLeaveScheduleKind,
  selectDefaultLeaveEndAt,
  selectDefaultLeaveTimeRange,
  type LeaveRequestImpactRequest,
  type LeaveRequestImpactSchedule,
} from '../../shared/leave-request-impact';
import * as leaveRequestImpactModule from '../../shared/leave-request-impact';

const HOUR_MS = 60 * 60 * 1000;

describe('createLeaveRequestShiftGroups', () => {
  const getCreateShiftGroups = () =>
    (
      leaveRequestImpactModule as typeof leaveRequestImpactModule & {
        createLeaveRequestShiftGroups?: (
          affectedSchedules: Array<{
            recordId: string;
            date: string;
            building: string;
            team: string;
            shift: string;
            kind?: string | null;
            scheduledHours: number;
            leaveHours: number;
            countedHours: number;
          }>,
        ) => unknown[];
      }
    ).createLeaveRequestShiftGroups;

  it('merges cross-building rows with the same actual shift window', () => {
    const createLeaveRequestShiftGroups = getCreateShiftGroups();
    expect(typeof createLeaveRequestShiftGroups).toBe('function');
    if (!createLeaveRequestShiftGroups) return;

    expect(
      createLeaveRequestShiftGroups([
        {
          recordId: 'rec-b',
          date: '2026-08-26',
          building: 'B楼',
          team: 'A班',
          shift: '白班',
          scheduledHours: 8,
          leaveHours: 8,
          countedHours: 0,
        },
        {
          recordId: 'rec-a',
          date: '2026-08-26',
          building: 'A楼',
          team: 'A班',
          shift: '白班',
          scheduledHours: 8,
          leaveHours: 8,
          countedHours: 8,
        },
      ]),
    ).toEqual([
      {
        shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
        scheduleDate: '2026-08-26',
        startAt: '2026-08-26T09:00',
        endAt: '2026-08-26T18:00',
        kind: 'white',
        shift: '白班',
        buildings: ['A楼', 'B楼'],
        teams: ['A班'],
        scheduleRecordIds: ['rec-a', 'rec-b'],
        leaveHours: 8,
      },
    ]);
  });

  it('keeps an ordinary night shift in its cross-day envelope', () => {
    const createLeaveRequestShiftGroups = getCreateShiftGroups();
    expect(typeof createLeaveRequestShiftGroups).toBe('function');
    if (!createLeaveRequestShiftGroups) return;

    expect(
      createLeaveRequestShiftGroups([
        {
          recordId: 'rec-night',
          date: '2026-08-27',
          building: 'A楼',
          team: 'B班',
          shift: '夜班',
          scheduledHours: 15,
          leaveHours: 15,
          countedHours: 15,
        },
      ]),
    ).toEqual([
      {
        shiftKey: '2026-08-27T18:00__2026-08-28T09:00',
        scheduleDate: '2026-08-27',
        startAt: '2026-08-27T18:00',
        endAt: '2026-08-28T09:00',
        kind: 'night',
        shift: '夜班',
        buildings: ['A楼'],
        teams: ['B班'],
        scheduleRecordIds: ['rec-night'],
        leaveHours: 15,
      },
    ]);
  });

  it('uses the resolved shift kind when the display label is customized', () => {
    const createLeaveRequestShiftGroups = getCreateShiftGroups();
    expect(typeof createLeaveRequestShiftGroups).toBe('function');
    if (!createLeaveRequestShiftGroups) return;

    expect(
      createLeaveRequestShiftGroups([
        {
          recordId: 'rec-night-custom-label',
          date: '2026-08-28',
          building: '1号楼',
          team: 'A班',
          shift: '夜间值守',
          kind: 'night',
          scheduledHours: 15,
          leaveHours: 15,
          countedHours: 15,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        shiftKey: '2026-08-28T18:00__2026-08-29T09:00',
        kind: 'night',
        shift: '夜间值守',
      }),
    ]);
  });
});

const createSchedule = (
  overrides: Partial<LeaveRequestImpactSchedule> = {},
): LeaveRequestImpactSchedule => ({
  recordId: 'schedule-1',
  scheduleDate: '2026-08-03',
  building: '1号楼',
  team: 'A班',
  shift: '白班',
  dutyStaffActual: ['张三'],
  ...overrides,
});

const createRequest = (
  overrides: Partial<LeaveRequestImpactRequest> = {},
): LeaveRequestImpactRequest => ({
  leaveStaffName: '张三',
  startAt: '2026-08-03T00:00',
  endAt: '2026-08-04T00:00',
  ...overrides,
});

describe('parseShanghaiLocalDateTime', () => {
  it('parses a strict whole-hour Shanghai wall-clock value', () => {
    expect(parseShanghaiLocalDateTime('2026-08-03T09:00')).toEqual({
      value: '2026-08-03T09:00',
      dateKey: '2026-08-03',
      wallClockHourIndex: Date.parse('2026-08-03T09:00:00.000Z') / HOUR_MS,
      epochMs: Date.parse('2026-08-03T01:00:00.000Z'),
    });
  });

  it.each([
    '',
    '2026-08-03',
    '2026-8-03T09:00',
    '2026-08-03T9:00',
    '2026-08-03T09:30',
    '2026-08-03T09:00:00',
    '2026-08-03T09:00+08:00',
    '2026-02-30T09:00',
    '2026-08-03T24:00',
    ' 2026-08-03T09:00',
  ])('rejects a non-strict or invalid value: %p', (value) => {
    expect(parseShanghaiLocalDateTime(value)).toBeNull();
  });
});

describe('createLeaveRequestImpactComparisonKey', () => {
  const impact = {
    affectedSchedules: [
      {
        recordId: 'rec-b',
        date: '2026-08-04',
        building: 'B楼',
        team: '二班',
        shift: '白班',
        scheduledHours: 8,
        leaveHours: 8,
        countedHours: 8,
      },
      {
        recordId: 'rec-a',
        date: '2026-08-03',
        building: 'A楼',
        team: '一班',
        shift: '夜班',
        scheduledHours: 15,
        leaveHours: 15,
        countedHours: 15,
      },
    ],
    excludedSchedules: [
      { recordId: 'rec-d', date: '2026-08-06', reason: 'holiday' as const },
      {
        recordId: 'rec-c',
        date: '2026-08-05',
        reason: 'weekend_rest' as const,
      },
    ],
    rawHours: 23,
    minimumHours: 23,
    unrecognizedShifts: ['未知乙', '未知甲'],
    missingCalendarYears: ['2028', '2027'],
    invalidRange: false,
    invalidRangeReason: null,
  };

  it('is stable when equivalent array values arrive in another order', () => {
    const reversed = {
      ...impact,
      affectedSchedules: [...impact.affectedSchedules].reverse(),
      excludedSchedules: [...impact.excludedSchedules].reverse(),
      unrecognizedShifts: [...impact.unrecognizedShifts].reverse(),
      missingCalendarYears: [...impact.missingCalendarYears].reverse(),
    };

    expect(createLeaveRequestImpactComparisonKey(reversed)).toBe(
      createLeaveRequestImpactComparisonKey(impact),
    );
  });

  it('detects changed shift details even when total hours stay the same', () => {
    const changed = {
      ...impact,
      affectedSchedules: impact.affectedSchedules.map((item, index) =>
        index === 0 ? { ...item, shift: '夜班' } : item,
      ),
    };

    expect(createLeaveRequestImpactComparisonKey(changed)).not.toBe(
      createLeaveRequestImpactComparisonKey(impact),
    );
  });

  it('rejects a malformed client impact snapshot', () => {
    expect(
      createLeaveRequestImpactComparisonKey({
        ...impact,
        rawHours: '23',
      }),
    ).toBeNull();
  });
});

describe('resolveLeaveScheduleKind', () => {
  it.each([
    [createSchedule({ team: '长白', shift: '白班' }), 'long_white'],
    [
      createSchedule({
        team: '',
        teamText: 'changbai',
        shift: '',
        shiftText: 'white_shift',
      }),
      'long_white',
    ],
    [createSchedule({ shift: 'long_white_shift' }), 'long_white'],
    [
      createSchedule({
        building: '',
        buildingText: 'station_110',
        shift: '',
        shiftText: 'white_shift',
      }),
      'station_110_white',
    ],
    [
      createSchedule({ building: '110监控室', shift: 'night_shift' }),
      'station_110_night',
    ],
    [createSchedule({ building: '110站', shift: '白班' }), 'station_110_white'],
    [
      createSchedule({ building: '110机房', shift: '夜班' }),
      'station_110_night',
    ],
    [createSchedule({ shift: '白' }), 'white'],
    [createSchedule({ shift: 'night' }), 'night'],
    [createSchedule({ shift: '中班' }), null],
  ] as const)(
    'classifies schedule aliases with priority',
    (schedule, expected) => {
      expect(resolveLeaveScheduleKind(schedule)).toBe(expected);
    },
  );

  it('lets station 110 classification override a long-white team label', () => {
    expect(
      resolveLeaveScheduleKind(
        createSchedule({ building: '110机房', team: '长白班', shift: '白班' }),
      ),
    ).toBe('station_110_white');
  });

  it('fails closed when shift candidates conflict between white and night', () => {
    expect(
      resolveLeaveScheduleKind(
        createSchedule({ shift: '夜班', shiftText: '白班' }),
      ),
    ).toBeNull();
  });

  it('does not classify a building whose longer number contains 110', () => {
    expect(
      resolveLeaveScheduleKind(
        createSchedule({ building: 'A1100', shift: '白班' }),
      ),
    ).toBe('white');
  });
});

describe('calculateLeaveRequestSubstituteRule', () => {
  it('does not require a substitute when every affected schedule is long-white', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({ team: '长白', shift: '白班' }),
        createSchedule({
          recordId: 'unaffected-white',
          scheduleDate: '2026-08-05',
        }),
      ],
      createRequest({
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(rule).toEqual({
      requiresSubstitute: false,
      blockedStaffNames: [],
    });
  });

  it('can force a substitute for a policy-scoped long-white applicant', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({
          team: '长白',
          shift: '白班',
          dutyStaffActual: ['张三'],
        }),
        createSchedule({
          recordId: 'same-window-candidate',
          dutyStaffActual: ['李四'],
        }),
      ],
      createRequest(),
      { forceRequiresSubstitute: true },
    );

    expect(rule.requiresSubstitute).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '张三')).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '李四')).toBe(true);
  });

  it('allows another same-day long-white employee for a policy-scoped long-white applicant', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({
          recordId: 'target-long-white',
          team: '长白',
          shift: '白班',
          dutyStaffActual: ['请假人'],
        }),
        createSchedule({
          recordId: 'candidate-long-white',
          building: '2号楼',
          team: '长白',
          shift: '白班',
          dutyStaffActual: ['长白候选人'],
        }),
      ],
      createRequest({
        leaveStaffName: '请假人',
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
      { forceRequiresSubstitute: true },
    );

    expect(rule.requiresSubstitute).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '请假人')).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '长白候选人')).toBe(false);
  });

  it('does not reconnect an unaffected ordinary schedule through a duplicate record ID', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({
          recordId: 'duplicate-id',
          team: '长白',
          shift: '白班',
        }),
        createSchedule({
          recordId: 'duplicate-id',
          scheduleDate: '2026-08-10',
          shift: '白班',
        }),
      ],
      createRequest({
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(rule).toEqual({
      requiresSubstitute: false,
      blockedStaffNames: [],
    });
  });

  it('does not let an unrelated duplicate-ID schedule block distant staff', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({ recordId: 'duplicate-id' }),
        createSchedule({
          recordId: 'duplicate-id',
          scheduleDate: '2026-08-10',
        }),
        createSchedule({
          recordId: 'distant-candidate',
          scheduleDate: '2026-08-10',
          dutyStaffActual: ['远期人员'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(rule.requiresSubstitute).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '远期人员')).toBe(false);
  });

  it('requires a substitute for an affected unknown shift and blocks both potential-window boundaries', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({ shift: '中班' }),
        createSchedule({
          recordId: 'unknown-previous-boundary',
          scheduleDate: '2026-08-02',
          building: '110',
          shift: '夜班',
          dutyStaffActual: ['未知前界人员'],
        }),
        createSchedule({
          recordId: 'unknown-next-boundary',
          scheduleDate: '2026-08-04',
          shift: '白班',
          dutyStaffActual: ['未知后界人员'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(rule.requiresSubstitute).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '未知前界人员')).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '未知后界人员')).toBe(true);
  });

  it('requires a substitute when long-white and 7x24 schedules are both affected', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({
          recordId: 'long-white',
          team: '长白',
          shift: '白班',
        }),
        createSchedule({
          recordId: 'ordinary-white',
          building: '2号楼',
          shift: '白班',
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(rule.requiresSubstitute).toBe(true);
  });

  it.each([
    { label: 'ordinary white', building: '1号楼', shift: '白班' },
    { label: 'ordinary night', building: '1号楼', shift: '夜班' },
    { label: 'station 110 white', building: '110', shift: '白班' },
    { label: 'station 110 night', building: '110', shift: '夜班' },
  ])('requires a substitute for an affected $label schedule', (schedule) => {
    const rule = calculateLeaveRequestSubstituteRule(
      [createSchedule(schedule)],
      createRequest(),
    );

    expect(rule.requiresSubstitute).toBe(true);
  });

  it('uses the full white envelope and blocks adjacent nights, cross-building duty, and self', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule(),
        createSchedule({
          recordId: 'previous-night',
          scheduleDate: '2026-08-02',
          shift: '夜班',
          dutyStaffActual: ['前夜人员'],
        }),
        createSchedule({
          recordId: 'next-night',
          shift: '夜班',
          dutyStaffActual: ['后夜人员'],
        }),
        createSchedule({
          recordId: 'other-building',
          building: '2号楼',
          dutyStaffActual: ['跨楼人员'],
        }),
        createSchedule({
          recordId: 'safe',
          scheduleDate: '2026-08-05',
          dutyStaffActual: ['安全人员'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(rule.requiresSubstitute).toBe(true);
    for (const name of ['张三', '前夜人员', '后夜人员', '跨楼人员']) {
      expect(isLeaveSubstituteStaffBlocked(rule, name)).toBe(true);
    }
    expect(isLeaveSubstituteStaffBlocked(rule, '安全人员')).toBe(false);
    expect(isLeaveSubstituteStaffBlocked(rule, '张三一')).toBe(false);
  });

  it('allows same-day long-white staff to substitute for an ordinary white shift', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule(),
        createSchedule({
          recordId: 'same-day-long-white',
          building: '2号楼',
          team: '长白',
          shift: '白班',
          dutyStaffActual: ['备岗人员', '实习生人员'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(rule.requiresSubstitute).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '备岗人员')).toBe(false);
    expect(isLeaveSubstituteStaffBlocked(rule, '实习生人员')).toBe(false);
  });

  it('still blocks same-day long-white staff who also worked the adjacent night', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule(),
        createSchedule({
          recordId: 'same-day-long-white',
          team: '长白',
          shift: '白班',
          dutyStaffActual: ['连续值守人员'],
        }),
        createSchedule({
          recordId: 'previous-night',
          scheduleDate: '2026-08-02',
          shift: '夜班',
          dutyStaffActual: ['连续值守人员'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(isLeaveSubstituteStaffBlocked(rule, '连续值守人员')).toBe(true);
  });

  it.each([
    {
      label: 'ordinary night',
      building: '1号楼',
      shift: '夜班',
      startAt: '2026-08-03T18:00',
      endAt: '2026-08-03T22:00',
    },
    {
      label: 'station 110 white',
      building: '110',
      shift: '白班',
      startAt: '2026-08-03T10:00',
      endAt: '2026-08-03T14:00',
    },
  ])('does not use the long-white exception for $label', (leaveSchedule) => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({
          building: leaveSchedule.building,
          shift: leaveSchedule.shift,
        }),
        createSchedule({
          recordId: 'same-day-long-white',
          building: '2号楼',
          team: '长白',
          shift: '白班',
          dutyStaffActual: ['长白人员'],
        }),
      ],
      createRequest({
        startAt: leaveSchedule.startAt,
        endAt: leaveSchedule.endAt,
      }),
    );

    expect(isLeaveSubstituteStaffBlocked(rule, '长白人员')).toBe(true);
  });

  it('uses the full night envelope and blocks the white shifts on both boundaries', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({ shift: '夜班' }),
        createSchedule({
          recordId: 'previous-white',
          dutyStaffActual: ['前白人员'],
        }),
        createSchedule({
          recordId: 'next-white',
          scheduleDate: '2026-08-04',
          dutyStaffActual: ['后白人员'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T23:00',
        endAt: '2026-08-04T01:00',
      }),
    );

    expect(isLeaveSubstituteStaffBlocked(rule, '前白人员')).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '后白人员')).toBe(true);
  });

  it.each([
    {
      label: 'station 110 white',
      leaveShift: '白班',
      requestStart: '2026-08-03T09:00',
      requestEnd: '2026-08-03T10:00',
      candidates: [
        createSchedule({
          recordId: 'station-previous-night',
          scheduleDate: '2026-08-02',
          building: '110',
          shift: '夜班',
          dutyStaffActual: ['110前夜'],
        }),
        createSchedule({
          recordId: 'station-next-night',
          building: '110',
          shift: '夜班',
          dutyStaffActual: ['110后夜'],
        }),
      ],
      blockedNames: ['110前夜', '110后夜'],
    },
    {
      label: 'station 110 night',
      leaveShift: '夜班',
      requestStart: '2026-08-03T21:00',
      requestEnd: '2026-08-03T22:00',
      candidates: [
        createSchedule({
          recordId: 'station-previous-white',
          building: '110',
          dutyStaffActual: ['110前白'],
        }),
        createSchedule({
          recordId: 'station-next-white',
          scheduleDate: '2026-08-04',
          building: '110',
          dutyStaffActual: ['110后白'],
        }),
      ],
      blockedNames: ['110前白', '110后白'],
    },
  ])('enforces both boundaries for $label', (scenario) => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({ building: '110', shift: scenario.leaveShift }),
        ...scenario.candidates,
      ],
      createRequest({
        startAt: scenario.requestStart,
        endAt: scenario.requestEnd,
      }),
    );

    for (const name of scenario.blockedNames) {
      expect(isLeaveSubstituteStaffBlocked(rule, name)).toBe(true);
    }
  });

  it('blocks an adjacent schedule across a month boundary', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({
          scheduleDate: '2026-07-31',
          shift: '夜班',
        }),
        createSchedule({
          recordId: 'august-white',
          scheduleDate: '2026-08-01',
          dutyStaffActual: ['跨月人员'],
        }),
      ],
      createRequest({
        startAt: '2026-08-01T00:00',
        endAt: '2026-08-01T01:00',
      }),
    );

    expect(isLeaveSubstituteStaffBlocked(rule, '跨月人员')).toBe(true);
  });

  it('does not block a long-white rest-day record', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule({ scheduleDate: '2026-08-02' }),
        createSchedule({
          recordId: 'resting-long-white',
          scheduleDate: '2026-08-02',
          team: '长白',
          dutyStaffActual: ['休息人员'],
        }),
      ],
      createRequest({
        startAt: '2026-08-02T10:00',
        endAt: '2026-08-02T11:00',
      }),
    );

    expect(rule.requiresSubstitute).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '休息人员')).toBe(false);
  });

  it('fails closed for a relevant unknown compound staff field without prefix matches', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule(),
        createSchedule({
          recordId: 'unknown-previous-day',
          scheduleDate: '2026-08-02',
          shift: '中班',
          dutyStaffActual: ['王五 赵六'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(isLeaveSubstituteStaffBlocked(rule, '王五')).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '赵六')).toBe(true);
    expect(isLeaveSubstituteStaffBlocked(rule, '王五一')).toBe(false);
  });

  it('keeps atomic compound names when an unseparated field is encountered first', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule(),
        createSchedule({
          recordId: 'compound-candidate',
          dutyStaffActual: ['王五赵六', '王五 赵六'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(rule.blockedStaffNames).toEqual([
      '张三',
      '王五',
      '王五赵六',
      '赵六',
    ]);
  });

  it('keeps atomic compound names when a separated field is encountered first', () => {
    const rule = calculateLeaveRequestSubstituteRule(
      [
        createSchedule(),
        createSchedule({
          recordId: 'compound-candidate',
          dutyStaffActual: ['王五 赵六', '王五赵六'],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(rule.blockedStaffNames).toEqual([
      '张三',
      '王五',
      '王五赵六',
      '赵六',
    ]);
  });
});

describe('createLeaveRequestTimeCandidates', () => {
  it('defaults the end time to the selected shift boundary', () => {
    const shiftRanges = [
      { startAt: '2026-09-01T09:00', endAt: '2026-09-01T18:00' },
    ];

    expect(
      selectDefaultLeaveEndAt(
        shiftRanges,
        '2026-09-01T09:00',
        [
          '2026-09-01T13:00',
          '2026-09-01T14:00',
          '2026-09-01T18:00',
        ],
      ),
    ).toBe('2026-09-01T18:00');
    expect(
      selectDefaultLeaveEndAt(
        shiftRanges,
        '2026-09-01T14:00',
        ['2026-09-01T18:00'],
      ),
    ).toBe('2026-09-01T18:00');
  });

  it('defaults an overnight selection to the originating shift end', () => {
    expect(
      selectDefaultLeaveEndAt(
        [
          {
            startAt: '2026-08-31T18:00',
            endAt: '2026-09-01T09:00',
          },
        ],
        '2026-08-31T23:00',
        ['2026-09-01T03:00', '2026-09-01T09:00'],
      ),
    ).toBe('2026-09-01T09:00');
  });

  it('keeps overnight hours grouped under the originating real shift', () => {
    const candidates = createLeaveRequestTimeCandidates(
      [
        createSchedule({
          recordId: 'target-night',
          scheduleDate: '2026-08-16',
          team: 'A班',
          shift: '夜班',
          dutyStaffActual: ['张三'],
        }),
        createSchedule({
          recordId: 'other-white',
          scheduleDate: '2026-08-17',
          team: 'B班',
          shift: '白班',
          dutyStaffActual: ['李四'],
        }),
      ],
      { leaveStaffName: '张三' },
    );
    const shiftRanges = (
      candidates as typeof candidates & {
        shiftRanges?: Array<{
          scheduleDate: string;
          kind: string;
          startAt: string;
          endAt: string;
        }>;
      }
    ).shiftRanges;

    expect(candidates.startOptions).toContain('2026-08-17T00:00');
    expect(shiftRanges).toEqual([
      {
        scheduleDate: '2026-08-16',
        kind: 'night',
        startAt: '2026-08-16T18:00',
        endAt: '2026-08-17T09:00',
      },
    ]);
  });

  it('selects the nearest real shift from today without a historical fallback', () => {
    const ranges = [
      { startAt: '2026-08-07T09:00', endAt: '2026-08-07T18:00' },
      { startAt: '2026-08-08T18:00', endAt: '2026-08-09T09:00' },
      { startAt: '2026-08-11T09:00', endAt: '2026-08-11T18:00' },
    ];

    expect(selectDefaultLeaveTimeRange(ranges, '2026-08-08')).toEqual(
      ranges[1],
    );
    expect(selectDefaultLeaveTimeRange([ranges[0]], '2026-08-08')).toBeNull();
  });

  it('excludes a long-white Sunday and keeps the next legal workday', () => {
    const candidates = createLeaveRequestTimeCandidates(
      [
        createSchedule({
          recordId: 'long-white-sunday',
          scheduleDate: '2026-08-02',
          team: '长白',
          shift: '白班',
        }),
        createSchedule({
          recordId: 'long-white-monday',
          scheduleDate: '2026-08-03',
          team: '长白',
          shift: '白班',
        }),
      ],
      { leaveStaffName: '张三' },
    );

    expect(candidates.startOptions).not.toEqual(
      expect.arrayContaining([expect.stringContaining('2026-08-02T')]),
    );
    expect(candidates.endOptions).not.toEqual(
      expect.arrayContaining([expect.stringContaining('2026-08-02T')]),
    );
    expect(candidates.startOptions).toContain('2026-08-03T09:00');
    expect(candidates.endOptions).toContain('2026-08-03T18:00');
    expect(candidates.fullShiftRanges).toContainEqual({
      startAt: '2026-08-03T09:00',
      endAt: '2026-08-03T18:00',
    });
    expect(
      selectDefaultLeaveTimeRange(candidates.fullShiftRanges, '2026-08-02'),
    ).toEqual({
      startAt: '2026-08-03T09:00',
      endAt: '2026-08-03T18:00',
    });
  });

  it('keeps a real weekend night shift and filters end times below four hours', () => {
    const schedules = [
      createSchedule({
        scheduleDate: '2026-08-02',
        shift: '夜班',
      }),
    ];
    const allCandidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
    });
    const selectedCandidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
      selectedStartAt: '2026-08-02T23:00',
    });

    expect(allCandidates.fullShiftRanges).toEqual([
      {
        startAt: '2026-08-02T18:00',
        endAt: '2026-08-03T09:00',
      },
    ]);
    expect(allCandidates.startOptions).toContain('2026-08-03T05:00');
    expect(allCandidates.startOptions).not.toContain('2026-08-03T06:00');
    expect(allCandidates.startOptions).not.toContain('2026-08-03T08:00');
    expect(allCandidates.startOptions).not.toContain('2026-08-03T09:00');
    expect(selectedCandidates.endOptions).not.toContain('2026-08-03T02:00');
    expect(selectedCandidates.endOptions).toContain('2026-08-03T03:00');
    expect(selectedCandidates.endOptions).toContain('2026-08-03T09:00');
  });

  it('uses white-shift work segments and skips the lunch break', () => {
    const schedules = [createSchedule({ shift: '白班' })];
    const candidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
      selectedStartAt: '2026-08-03T10:00',
    });

    expect(candidates.startOptions).toContain('2026-08-03T11:00');
    expect(candidates.startOptions).not.toContain('2026-08-03T12:00');
    expect(candidates.startOptions).toContain('2026-08-03T13:00');
    expect(candidates.endOptions).not.toContain('2026-08-03T12:00');
    expect(candidates.endOptions).toContain('2026-08-03T15:00');
  });

  it('uses 110 schedule boundaries and exact personnel matching', () => {
    const candidates = createLeaveRequestTimeCandidates(
      [
        createSchedule({
          building: '110站',
          shift: '白班',
          dutyStaffActual: ['张三 李四'],
        }),
      ],
      { leaveStaffName: '张三' },
    );
    const otherPerson = createLeaveRequestTimeCandidates(
      [
        createSchedule({
          building: '110站',
          shift: '白班',
          dutyStaffActual: ['张三一 李四'],
        }),
      ],
      { leaveStaffName: '张三' },
    );

    expect(candidates.fullShiftRanges).toEqual([
      {
        startAt: '2026-08-03T08:00',
        endAt: '2026-08-03T20:00',
      },
    ]);
    expect(candidates.startOptions).toContain('2026-08-03T08:00');
    expect(candidates.endOptions).toContain('2026-08-03T20:00');
    expect(otherPerson.startOptions).toEqual([]);
    expect(otherPerson.endOptions).toEqual([]);
  });

  it('uses the 110 night window across midnight and removes starts below four hours', () => {
    const schedules = [
      createSchedule({
        building: '110站',
        shift: '夜班',
        scheduleDate: '2026-05-01',
      }),
    ];
    const allCandidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
    });
    const selectedCandidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
      selectedStartAt: '2026-05-02T04:00',
    });

    expect(allCandidates.fullShiftRanges).toEqual([
      {
        startAt: '2026-05-01T20:00',
        endAt: '2026-05-02T08:00',
      },
    ]);
    expect(allCandidates.startOptions).toContain('2026-05-02T04:00');
    expect(allCandidates.startOptions).not.toContain('2026-05-02T05:00');
    expect(selectedCandidates.endOptions).toEqual(['2026-05-02T08:00']);
  });

  it('uses the official long-white holiday and adjusted-workday calendar', () => {
    const candidates = createLeaveRequestTimeCandidates(
      [
        createSchedule({
          recordId: 'holiday',
          scheduleDate: '2026-05-01',
          team: '长白',
          shift: '白班',
        }),
        createSchedule({
          recordId: 'adjusted-workday',
          scheduleDate: '2026-05-09',
          team: '长白',
          shift: '白班',
        }),
      ],
      { leaveStaffName: '张三' },
    );

    expect(candidates.startOptions).not.toEqual(
      expect.arrayContaining([expect.stringContaining('2026-05-01T')]),
    );
    expect(candidates.startOptions).toContain('2026-05-09T09:00');
    expect(candidates.fullShiftRanges).toEqual([
      {
        startAt: '2026-05-09T09:00',
        endAt: '2026-05-09T18:00',
      },
    ]);
  });

  it('fails closed for a long-white year without official calendar data', () => {
    const candidates = createLeaveRequestTimeCandidates(
      [
        createSchedule({
          recordId: 'known-white',
          scheduleDate: '2027-08-02',
          team: 'A班',
          shift: '白班',
        }),
        createSchedule({
          recordId: 'missing-calendar',
          scheduleDate: '2027-08-02',
          team: '长白',
          shift: '白班',
        }),
      ],
      { leaveStaffName: '张三' },
    );

    expect(candidates).toEqual({
      startOptions: [],
      endOptions: [],
      fullShiftRanges: [],
      shiftRanges: [],
    });
  });

  it('does not suggest a full-shift default when an unknown shift blocks it', () => {
    const schedules = [
      createSchedule({ recordId: 'known-white', shift: '白班' }),
      createSchedule({ recordId: 'unknown', shift: '中班' }),
    ];
    const allCandidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
    });
    const selectedCandidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
      selectedStartAt: '2026-08-03T09:00',
    });

    expect(allCandidates.startOptions).toEqual([]);
    expect(allCandidates.endOptions).toEqual([]);
    expect(allCandidates.fullShiftRanges).toEqual([]);
    expect(selectedCandidates.endOptions).toEqual([]);
  });

  it('fails closed when conflicting white and night labels overlap a known shift', () => {
    const schedules = [
      createSchedule({ recordId: 'known-white', shift: '白班' }),
      createSchedule({
        recordId: 'conflicting',
        shift: '夜班',
        shiftText: '白班',
      }),
    ];
    const allCandidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
    });
    const selectedCandidates = createLeaveRequestTimeCandidates(schedules, {
      leaveStaffName: '张三',
      selectedStartAt: '2026-08-03T09:00',
    });

    expect(allCandidates).toEqual({
      startOptions: [],
      endOptions: [],
      fullShiftRanges: [],
      shiftRanges: [],
    });
    expect(selectedCandidates.endOptions).toEqual([]);
  });
});

describe('calculateLeaveRequestImpact', () => {
  it('counts a complete ordinary white shift as eight hours', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule()],
      createRequest({
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(result).toMatchObject({
      rawHours: 8,
      minimumHours: 8,
      invalidRange: false,
      invalidRangeReason: null,
      excludedSchedules: [],
      missingCalendarYears: [],
      unrecognizedShifts: [],
      affectedSchedules: [
        {
          recordId: 'schedule-1',
          date: '2026-08-03',
          scheduledHours: 8,
          leaveHours: 8,
          countedHours: 8,
        },
      ],
    });
    expect(result.affectedSchedules[0]).not.toHaveProperty('shiftHours');
    expect(result.affectedSchedules[0]).not.toHaveProperty('countedForHours');
  });

  it.each([
    ['2026-08-03T10:00', '2026-08-03T15:00', 4],
    ['2026-08-03T11:00', '2026-08-03T16:00', 4],
  ])(
    'subtracts the white-shift lunch break for %s to %s',
    (startAt, endAt, expectedHours) => {
      const result = calculateLeaveRequestImpact(
        [createSchedule()],
        createRequest({ startAt, endAt }),
      );

      expect(result.rawHours).toBe(expectedHours);
      expect(result.minimumHours).toBe(expectedHours);
      expect(result.affectedSchedules).toMatchObject([
        {
          scheduledHours: 8,
          leaveHours: expectedHours,
          countedHours: expectedHours,
        },
      ]);
    },
  );

  it('counts the lunch break itself as zero hours', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule()],
      createRequest({
        startAt: '2026-08-03T12:00',
        endAt: '2026-08-03T13:00',
      }),
    );

    expect(result.rawHours).toBe(0);
    expect(result.minimumHours).toBe(0);
    expect(result.affectedSchedules).toEqual([]);
  });

  it('preserves a real three-hour preview without raising it to four', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule()],
      createRequest({
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T12:00',
      }),
    );

    expect(result.rawHours).toBe(3);
    expect(result.minimumHours).toBe(3);
    expect(result.affectedSchedules[0]).toMatchObject({
      leaveHours: 3,
      countedHours: 3,
    });
  });

  it('counts a complete ordinary night shift as fifteen hours', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ shift: '夜班' })],
      createRequest({
        startAt: '2026-08-03T18:00',
        endAt: '2026-08-04T09:00',
      }),
    );

    expect(result.rawHours).toBe(15);
    expect(result.minimumHours).toBe(15);
    expect(result.affectedSchedules).toMatchObject([
      { scheduledHours: 15, leaveHours: 15, countedHours: 15 },
    ]);
  });

  it('counts a partial night interval across midnight', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ shift: 'night_shift' })],
      createRequest({
        startAt: '2026-08-03T23:00',
        endAt: '2026-08-04T03:00',
      }),
    );

    expect(result.rawHours).toBe(4);
    expect(result.minimumHours).toBe(4);
    expect(result.affectedSchedules[0]).toMatchObject({
      scheduledHours: 15,
      leaveHours: 4,
      countedHours: 4,
    });
  });

  it.each([
    {
      label: 'white',
      shift: '白班',
      startAt: '2026-05-01T08:00',
      endAt: '2026-05-01T20:00',
    },
    {
      label: 'night',
      shift: '夜班',
      startAt: '2026-05-01T20:00',
      endAt: '2026-05-02T08:00',
    },
    {
      label: 'white with a long-white team label',
      shift: '白班',
      team: '长白班',
      startAt: '2026-05-01T08:00',
      endAt: '2026-05-01T20:00',
    },
  ])(
    'counts a station 110 $label shift as twelve hours even on a holiday',
    ({ shift, team, startAt, endAt }) => {
      const result = calculateLeaveRequestImpact(
        [
          createSchedule({
            scheduleDate: '2026-05-01',
            building: '110监控室',
            team,
            shift,
          }),
        ],
        createRequest({ startAt, endAt }),
      );

      expect(result.rawHours).toBe(12);
      expect(result.minimumHours).toBe(12);
      expect(result.excludedSchedules).toEqual([]);
      expect(result.affectedSchedules).toMatchObject([
        { scheduledHours: 12, leaveHours: 12, countedHours: 12 },
      ]);
    },
  );

  it.each([
    ['weekday', '2026-08-03'],
    ['adjusted workday', '2026-05-09'],
  ])('counts long-white on a supported %s', (_label, date) => {
    const result = calculateLeaveRequestImpact(
      [
        createSchedule({
          scheduleDate: date,
          team: '长白',
          shift: '白班',
        }),
      ],
      createRequest({
        startAt: `${date}T09:00`,
        endAt: `${date}T18:00`,
      }),
    );

    expect(result.rawHours).toBe(8);
    expect(result.minimumHours).toBe(8);
    expect(result.excludedSchedules).toEqual([]);
    expect(result.affectedSchedules).toMatchObject([
      { scheduledHours: 8, leaveHours: 8, countedHours: 8 },
    ]);
  });

  it.each([
    ['2026-05-01', 'holiday'],
    ['2026-08-01', 'weekend_rest'],
  ] as const)('excludes long-white on non-working date %s', (date, reason) => {
    const result = calculateLeaveRequestImpact(
      [
        createSchedule({
          scheduleDate: date,
          team: '长白班',
          shift: 'white_shift',
        }),
      ],
      createRequest({
        startAt: `${date}T09:00`,
        endAt: `${date}T18:00`,
      }),
    );

    expect(result.rawHours).toBe(0);
    expect(result.minimumHours).toBe(0);
    expect(result.affectedSchedules).toEqual([]);
    expect(result.excludedSchedules).toEqual([
      { recordId: 'schedule-1', date, reason },
    ]);
    expect(result.missingCalendarYears).toEqual([]);
  });

  it('deduplicates duplicate white windows across buildings', () => {
    const result = calculateLeaveRequestImpact(
      [
        createSchedule({ recordId: 'building-1', building: '1号楼' }),
        createSchedule({
          recordId: 'building-2',
          building: '2号楼',
          shift: 'white_shift',
          dutyStaffActual: [' 张 三 '],
        }),
      ],
      createRequest({
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(result.rawHours).toBe(8);
    expect(result.minimumHours).toBe(8);
    expect(
      result.affectedSchedules.map(({ leaveHours, countedHours }) => ({
        leaveHours,
        countedHours,
      })),
    ).toEqual([
      { leaveHours: 8, countedHours: 8 },
      { leaveHours: 8, countedHours: 0 },
    ]);
  });

  it('unions an overlapping station-110 white shift and ordinary white shift', () => {
    const result = calculateLeaveRequestImpact(
      [
        createSchedule({ recordId: 'station', building: '110', shift: '白班' }),
        createSchedule({ recordId: 'ordinary', building: '1号楼' }),
      ],
      createRequest({
        startAt: '2026-08-03T08:00',
        endAt: '2026-08-03T20:00',
      }),
    );

    expect(result.rawHours).toBe(12);
    expect(result.minimumHours).toBe(12);
    expect(result.affectedSchedules).toMatchObject([
      { recordId: 'station', leaveHours: 12, countedHours: 12 },
      { recordId: 'ordinary', leaveHours: 8, countedHours: 0 },
    ]);
  });

  it('keeps overlapping attribution and output order independent of input order', () => {
    const station = createSchedule({
      recordId: 'station',
      building: '110',
      shift: '白班',
    });
    const ordinary = createSchedule({
      recordId: 'ordinary',
      building: '1号楼',
      shift: '白班',
    });
    const request = createRequest({
      startAt: '2026-08-03T08:00',
      endAt: '2026-08-03T20:00',
    });

    const forward = calculateLeaveRequestImpact([station, ordinary], request);
    const reversed = calculateLeaveRequestImpact([ordinary, station], request);

    expect(reversed).toEqual(forward);
    expect(reversed.affectedSchedules).toMatchObject([
      { recordId: 'station', leaveHours: 12, countedHours: 12 },
      { recordId: 'ordinary', leaveHours: 8, countedHours: 0 },
    ]);
  });

  it('does not count a night shift when leave ends exactly at 18:00', () => {
    const result = calculateLeaveRequestImpact(
      [
        createSchedule({ recordId: 'white', shift: '白班' }),
        createSchedule({ recordId: 'night', shift: '夜班' }),
      ],
      createRequest({
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(result.rawHours).toBe(8);
    expect(result.affectedSchedules.map((item) => item.recordId)).toEqual([
      'white',
    ]);
  });

  it.each([
    {
      request: createRequest({ startAt: '2026-08-03T09:30' }),
      reason: 'invalid_start_at',
    },
    {
      request: createRequest({ endAt: '2026-08-03T18:30' }),
      reason: 'invalid_end_at',
    },
    {
      request: createRequest({ startAt: '2026-02-30T09:00' }),
      reason: 'invalid_start_at',
    },
    {
      request: createRequest({
        startAt: '2026-08-03T18:00',
        endAt: '2026-08-03T18:00',
      }),
      reason: 'end_not_after_start',
    },
    {
      request: createRequest({
        startAt: '2026-08-03T19:00',
        endAt: '2026-08-03T18:00',
      }),
      reason: 'end_not_after_start',
    },
  ] as const)(
    'returns an explicit invalid range: $reason',
    ({ request, reason }) => {
      expect(calculateLeaveRequestImpact([createSchedule()], request)).toEqual({
        affectedSchedules: [],
        excludedSchedules: [],
        rawHours: 0,
        minimumHours: 0,
        unrecognizedShifts: [],
        missingCalendarYears: [],
        invalidRange: true,
        invalidRangeReason: reason,
      });
    },
  );

  it('keeps an unknown shift at zero hours and reports it', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ shift: '中班' })],
      createRequest({
        startAt: '2026-08-03T10:00',
        endAt: '2026-08-03T11:00',
      }),
    );

    expect(result.rawHours).toBe(0);
    expect(result.minimumHours).toBe(0);
    expect(result.unrecognizedShifts).toEqual(['中班']);
    expect(result.affectedSchedules).toMatchObject([
      {
        recordId: 'schedule-1',
        scheduledHours: 0,
        leaveHours: 0,
        countedHours: 0,
      },
    ]);
  });

  it('ignores an unknown shift outside the leave-related time range', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ scheduleDate: '2026-08-10', shift: '中班' })],
      createRequest({
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(result.unrecognizedShifts).toEqual([]);
    expect(result.affectedSchedules).toEqual([]);
  });

  it('reports both conflicting shift candidates as an unknown shift', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ shift: '夜班', shiftText: '白班' })],
      createRequest({
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(result.rawHours).toBe(0);
    expect(result.unrecognizedShifts).toEqual(['白班 / 夜班']);
    expect(result.affectedSchedules).toMatchObject([
      {
        recordId: 'schedule-1',
        shift: '白班 / 夜班',
        scheduledHours: 0,
        leaveHours: 0,
        countedHours: 0,
      },
    ]);
  });

  it('orders unknown schedules independently of input order', () => {
    const buildingTwo = createSchedule({
      recordId: 'unknown-building-2',
      building: '2号楼',
      shift: '中班',
    });
    const buildingOne = createSchedule({
      recordId: 'unknown-building-1',
      building: '1号楼',
      shift: '早班',
    });
    const request = createRequest({
      startAt: '2026-08-03T10:00',
      endAt: '2026-08-03T11:00',
    });

    const forward = calculateLeaveRequestImpact(
      [buildingTwo, buildingOne],
      request,
    );
    const reversed = calculateLeaveRequestImpact(
      [buildingOne, buildingTwo],
      request,
    );

    expect(reversed).toEqual(forward);
  });

  it('keeps a prior-day unknown shift relevant through next-day 09:00', () => {
    const result = calculateLeaveRequestImpact(
      [
        createSchedule({
          scheduleDate: '2026-08-02',
          shift: '中班',
        }),
      ],
      createRequest({
        startAt: '2026-08-03T00:00',
        endAt: '2026-08-03T03:00',
      }),
    );

    expect(result.unrecognizedShifts).toEqual(['中班']);
    expect(result.affectedSchedules).toMatchObject([
      {
        date: '2026-08-02',
        scheduledHours: 0,
        leaveHours: 0,
        countedHours: 0,
      },
    ]);
  });

  it('does not report an anchor-day unknown shift before its earliest 08:00 start', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ shift: '中班' })],
      createRequest({
        startAt: '2026-08-03T00:00',
        endAt: '2026-08-03T03:00',
      }),
    );

    expect(result.unrecognizedShifts).toEqual([]);
    expect(result.affectedSchedules).toEqual([]);
  });

  it('treats 08:00 as the inclusive earliest boundary for an unknown shift', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ shift: '中班' })],
      createRequest({
        startAt: '2026-08-03T08:00',
        endAt: '2026-08-03T09:00',
      }),
    );

    expect(result.unrecognizedShifts).toEqual(['中班']);
    expect(result.affectedSchedules).toHaveLength(1);
  });

  it('keeps an unknown shift relevant until the exclusive next-day 09:00 boundary', () => {
    const beforeBoundary = calculateLeaveRequestImpact(
      [createSchedule({ shift: '中班' })],
      createRequest({
        startAt: '2026-08-04T08:00',
        endAt: '2026-08-04T09:00',
      }),
    );
    const atBoundary = calculateLeaveRequestImpact(
      [createSchedule({ shift: '中班' })],
      createRequest({
        startAt: '2026-08-04T09:00',
        endAt: '2026-08-04T10:00',
      }),
    );

    expect(beforeBoundary.unrecognizedShifts).toEqual(['中班']);
    expect(beforeBoundary.affectedSchedules).toHaveLength(1);
    expect(atBoundary.unrecognizedShifts).toEqual([]);
    expect(atBoundary.affectedSchedules).toEqual([]);
  });

  it('excludes long-white when annual calendar data is missing', () => {
    const result = calculateLeaveRequestImpact(
      [
        createSchedule({
          scheduleDate: '2027-08-02',
          team: 'long_white_shift',
          shift: '白班',
        }),
      ],
      createRequest({
        startAt: '2027-08-02T09:00',
        endAt: '2027-08-02T18:00',
      }),
    );

    expect(result.rawHours).toBe(0);
    expect(result.affectedSchedules).toEqual([]);
    expect(result.missingCalendarYears).toEqual(['2027']);
    expect(result.excludedSchedules).toEqual([
      {
        recordId: 'schedule-1',
        date: '2027-08-02',
        reason: 'calendar_data_missing',
      },
    ]);
  });

  it('matches early-month leave against the prior-day night schedule', () => {
    const result = calculateLeaveRequestImpact(
      [
        createSchedule({
          scheduleDate: '2026-07-31',
          shift: '夜班',
        }),
      ],
      createRequest({
        startAt: '2026-08-01T00:00',
        endAt: '2026-08-01T03:00',
      }),
    );

    expect(result.rawHours).toBe(3);
    expect(result.minimumHours).toBe(3);
    expect(result.affectedSchedules).toMatchObject([
      {
        date: '2026-07-31',
        scheduledHours: 15,
        leaveHours: 3,
        countedHours: 3,
      },
    ]);
  });

  it('matches an exact name inside a multi-person value', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ dutyStaffActual: ['周庆庆 施海伟'] })],
      createRequest({
        leaveStaffName: '周庆庆',
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(result.rawHours).toBe(8);
    expect(result.affectedSchedules).toHaveLength(1);
  });

  it('does not treat a staff-name prefix as an exact multi-person match', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule({ dutyStaffActual: ['周庆庆一 施海伟'] })],
      createRequest({
        leaveStaffName: '周庆庆',
        startAt: '2026-08-03T09:00',
        endAt: '2026-08-03T18:00',
      }),
    );

    expect(result.rawHours).toBe(0);
    expect(result.affectedSchedules).toEqual([]);
  });

  it('returns an empty valid impact for a blank staff name', () => {
    const result = calculateLeaveRequestImpact(
      [createSchedule()],
      createRequest({ leaveStaffName: '   ' }),
    );

    expect(result).toEqual({
      affectedSchedules: [],
      excludedSchedules: [],
      rawHours: 0,
      minimumHours: 0,
      unrecognizedShifts: [],
      missingCalendarYears: [],
      invalidRange: false,
      invalidRangeReason: null,
    });
  });
});
