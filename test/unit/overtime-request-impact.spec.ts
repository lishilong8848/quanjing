import type {
  OvertimeRequestCreateRequest,
  OvertimeRequestCreateResponse,
} from '../../shared/api.interface';
import {
  calculateOvertimeRequestImpact,
  createOvertimeRequestImpactComparisonKey,
  type OvertimeRequestImpact,
  type OvertimeRequestImpactRequest,
  type OvertimeRequestImpactSchedule,
} from '../../shared/overtime-request-impact';

const createSchedule = (
  overrides: Partial<OvertimeRequestImpactSchedule> = {},
): OvertimeRequestImpactSchedule => ({
  recordId: 'schedule-1',
  scheduleDate: '2026-08-08',
  building: '1号楼',
  team: 'A班',
  shift: '白班',
  dutyStaffActual: ['张三'],
  ...overrides,
});

type OvertimeRequestImpactScheduleWithAssignmentContext =
  OvertimeRequestImpactSchedule & {
    dutyStaffReference?: string[];
    personText?: string;
    leaveStaff?: string[];
    substituteStaff?: string[];
  };

const createScheduleWithAssignmentContext = (
  overrides: Partial<OvertimeRequestImpactScheduleWithAssignmentContext> = {},
): OvertimeRequestImpactScheduleWithAssignmentContext => ({
  ...createSchedule(overrides),
  ...overrides,
});

const createRequest = (
  overrides: Partial<OvertimeRequestImpactRequest> = {},
): OvertimeRequestImpactRequest => ({
  staffName: '张三',
  startAt: '2026-08-08T18:00:00+08:00',
  endAt: '2026-08-08T22:00:00+08:00',
  ...overrides,
});

type OvertimeRequestWithStaffShift = OvertimeRequestImpactRequest & {
  staffShift?: string | null;
};

const createRequestWithStaffShift = (
  staffShift: string | null,
  overrides: Partial<OvertimeRequestImpactRequest> = {},
): OvertimeRequestWithStaffShift => ({
  ...createRequest(overrides),
  staffShift,
});

describe('calculateOvertimeRequestImpact', () => {
  it('deducts the Shanghai lunch break from daytime overtime', () => {
    const result = calculateOvertimeRequestImpact(
      [createSchedule({ dutyStaffActual: ['李四'] })],
      createRequest({
        startAt: '2026-08-08T10:00:00+08:00',
        endAt: '2026-08-08T15:00:00+08:00',
      }),
    );

    expect(result).toEqual({
      rawHours: 5,
      payableHours: 4,
      conflictingSchedules: [],
      isWholeHour: true,
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it('counts 09:00 to 18:00 as 8 payable hours', () => {
    expect(
      calculateOvertimeRequestImpact(
        [],
        createRequest({
          startAt: '2026-08-08T09:00:00+08:00',
          endAt: '2026-08-08T18:00:00+08:00',
        }),
      ),
    ).toMatchObject({
      rawHours: 9,
      payableHours: 8,
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it('counts 18:00 to next-day 09:00 as 15 payable hours', () => {
    expect(
      calculateOvertimeRequestImpact(
        [],
        createRequest({
          startAt: '2026-08-08T18:00:00+08:00',
          endAt: '2026-08-09T09:00:00+08:00',
        }),
      ),
    ).toMatchObject({
      rawHours: 15,
      payableHours: 15,
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it('rejects a range containing only the unpaid lunch break', () => {
    expect(
      calculateOvertimeRequestImpact(
        [],
        createRequest({
          startAt: '2026-08-08T12:00:00+08:00',
          endAt: '2026-08-08T13:00:00+08:00',
        }),
      ),
    ).toMatchObject({
      rawHours: 1,
      payableHours: 0,
      invalidRangeReason: 'below_minimum_hours',
      canSubmit: false,
    });
  });

  it('allows a whole-hour range across midnight', () => {
    const result = calculateOvertimeRequestImpact(
      [],
      createRequest({
        startAt: '2026-08-08T22:00:00+08:00',
        endAt: '2026-08-09T04:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      rawHours: 6,
      payableHours: 6,
      isWholeHour: true,
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it.each([
    {
      label: 'start without a timezone',
      request: createRequest({ startAt: '2026-08-08T18:00:00' }),
      reason: 'invalid_start_at',
    },
    {
      label: 'invalid end calendar date',
      request: createRequest({ endAt: '2026-02-30T22:00:00+08:00' }),
      reason: 'invalid_end_at',
    },
  ] as const)('rejects $label', ({ request, reason }) => {
    expect(calculateOvertimeRequestImpact([], request)).toEqual({
      rawHours: 0,
      payableHours: 0,
      conflictingSchedules: [],
      isWholeHour: false,
      invalidRangeReason: reason,
      canSubmit: false,
    });
  });

  it('rejects a non-whole-hour range', () => {
    expect(
      calculateOvertimeRequestImpact(
        [],
        createRequest({ startAt: '2026-08-08T18:30:00+08:00' }),
      ),
    ).toMatchObject({
      rawHours: 3.5,
      payableHours: 0,
      isWholeHour: false,
      invalidRangeReason: 'not_whole_hour',
      canSubmit: false,
    });
  });

  it('accepts a source offset time that converts to a Shanghai whole hour', () => {
    const result = calculateOvertimeRequestImpact(
      [],
      createRequest({
        startAt: '2026-08-08T15:30:00+05:30',
        endAt: '2026-08-08T19:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      rawHours: 1,
      payableHours: 1,
      isWholeHour: true,
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it.each([
    ['equal', '2026-08-08T18:00:00+08:00'],
    ['earlier', '2026-08-08T17:00:00+08:00'],
  ])('requires the end to be strictly later when it is %s', (_label, endAt) => {
    expect(
      calculateOvertimeRequestImpact([], createRequest({ endAt })),
    ).toMatchObject({
      rawHours: 0,
      payableHours: 0,
      isWholeHour: true,
      invalidRangeReason: 'end_not_after_start',
      canSubmit: false,
    });
  });

  it('returns the matching normal schedule when the request overlaps it', () => {
    const result = calculateOvertimeRequestImpact(
      [createSchedule()],
      createRequest({
        startAt: '2026-08-08T17:00:00+08:00',
        endAt: '2026-08-08T19:00:00+08:00',
      }),
    );

    expect(result).toEqual({
      rawHours: 2,
      payableHours: 2,
      conflictingSchedules: [
        {
          recordId: 'schedule-1',
          date: '2026-08-08',
          building: '1号楼',
          team: 'A班',
          shift: '白班',
          overlapHours: 1,
        },
      ],
      isWholeHour: true,
      invalidRangeReason: null,
      canSubmit: false,
    });
  });

  it('allows a request that only touches the end boundary of a schedule', () => {
    const result = calculateOvertimeRequestImpact(
      [createSchedule()],
      createRequest({
        startAt: '2026-08-08T18:00:00+08:00',
        endAt: '2026-08-08T19:00:00+08:00',
      }),
    );

    expect(result.conflictingSchedules).toEqual([]);
    expect(result.canSubmit).toBe(true);
  });

  it('detects an overnight schedule on the following calendar day', () => {
    const result = calculateOvertimeRequestImpact(
      [createSchedule({ shift: '夜班' })],
      createRequest({
        startAt: '2026-08-09T08:00:00+08:00',
        endAt: '2026-08-09T10:00:00+08:00',
      }),
    );

    expect(result.conflictingSchedules).toMatchObject([
      {
        recordId: 'schedule-1',
        date: '2026-08-08',
        shift: '夜班',
        overlapHours: 1,
      },
    ]);
    expect(result.canSubmit).toBe(false);
  });

  it('fails closed for an overlapping unknown shift using the potential window', () => {
    const result = calculateOvertimeRequestImpact(
      [createSchedule({ shift: '中班' })],
      createRequest({
        startAt: '2026-08-08T20:00:00+08:00',
        endAt: '2026-08-08T21:00:00+08:00',
      }),
    );

    expect(result.conflictingSchedules).toMatchObject([
      {
        recordId: 'schedule-1',
        date: '2026-08-08',
        shift: '中班',
        overlapHours: 1,
      },
    ]);
    expect(result.canSubmit).toBe(false);
  });

  it('fails closed for long-white when calendar data is unsupported', () => {
    const result = calculateOvertimeRequestImpact(
      [
        createSchedule({
          scheduleDate: '2027-08-02',
          team: '长白',
          shift: '白班',
        }),
      ],
      createRequest({
        startAt: '2027-08-02T10:00:00+08:00',
        endAt: '2027-08-02T11:00:00+08:00',
      }),
    );

    expect(result.conflictingSchedules).toMatchObject([
      {
        recordId: 'schedule-1',
        date: '2027-08-02',
        shift: '白班',
        overlapHours: 1,
      },
    ]);
    expect(result.invalidRangeReason).toBe('calendar_data_missing');
    expect(result.canSubmit).toBe(false);
  });

  it('matches a staff name exactly inside a multi-person field', () => {
    const request = createRequest({
      startAt: '2026-08-08T17:00:00+08:00',
      endAt: '2026-08-08T19:00:00+08:00',
    });

    expect(
      calculateOvertimeRequestImpact(
        [createSchedule({ dutyStaffActual: ['张三一 李四'] })],
        request,
      ).conflictingSchedules,
    ).toEqual([]);
    expect(
      calculateOvertimeRequestImpact(
        [createSchedule({ dutyStaffActual: ['王五 张三'] })],
        request,
      ).conflictingSchedules,
    ).toHaveLength(1);
  });

  it('does not treat a blank staff name as submit-ready', () => {
    expect(
      calculateOvertimeRequestImpact([], createRequest({ staffName: '   ' })),
    ).toMatchObject({
      conflictingSchedules: [],
      invalidRangeReason: null,
      canSubmit: false,
    });
  });
});

describe('approved leave substitute overtime policy', () => {
  const substituteStaffName = 'substitute-staff';
  const leaveStaffName = 'leave-staff';

  const createApprovedSubstituteSchedule = (
    overrides: Partial<OvertimeRequestImpactScheduleWithAssignmentContext> = {},
  ): OvertimeRequestImpactScheduleWithAssignmentContext =>
    createScheduleWithAssignmentContext({
      recordId: 'approved-substitute-white',
      scheduleDate: '2026-08-10',
      building: 'building-a',
      team: 'shift-a',
      shift: 'white',
      dutyStaffActual: [substituteStaffName],
      dutyStaffReference: [leaveStaffName],
      personText: leaveStaffName,
      leaveStaff: [leaveStaffName],
      substituteStaff: [substituteStaffName],
      ...overrides,
    });

  const createSubstituteRequest = (
    overrides: Partial<OvertimeRequestImpactRequest> = {},
  ): OvertimeRequestWithStaffShift =>
    createRequestWithStaffShift('shift_a', {
      staffName: substituteStaffName,
      startAt: '2026-08-10T09:00:00+08:00',
      endAt: '2026-08-10T18:00:00+08:00',
      ...overrides,
    });

  it('allows an approved substitute to file overtime for the substituted shift after the roster update', () => {
    const result = calculateOvertimeRequestImpact(
      [createApprovedSubstituteSchedule()],
      createSubstituteRequest(),
    );

    expect(result).toMatchObject({
      rawHours: 9,
      payableHours: 8,
      conflictingSchedules: [],
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it('still rejects overlap with the staff member original roster assignment', () => {
    const result = calculateOvertimeRequestImpact(
      [
        createScheduleWithAssignmentContext({
          recordId: 'original-white',
          scheduleDate: '2026-08-10',
          shift: 'white',
          dutyStaffActual: [substituteStaffName],
          dutyStaffReference: [substituteStaffName],
          personText: substituteStaffName,
        }),
      ],
      createSubstituteRequest(),
    );

    expect(result.conflictingSchedules).toMatchObject([
      { recordId: 'original-white', overlapHours: 8 },
    ]);
    expect(result.canSubmit).toBe(false);
  });

  it('fails closed when dirty data lists the same person as both original staff and substitute', () => {
    const result = calculateOvertimeRequestImpact(
      [
        createApprovedSubstituteSchedule({
          recordId: 'dirty-dual-role-white',
          dutyStaffReference: [substituteStaffName],
          personText: `${leaveStaffName} ${substituteStaffName}`,
        }),
      ],
      createSubstituteRequest(),
    );

    expect(result.conflictingSchedules).toMatchObject([
      { recordId: 'dirty-dual-role-white', overlapHours: 8 },
    ]);
    expect(result.canSubmit).toBe(false);
  });

  it('still rejects 24 continuous hours across an original night shift and an approved substitute white shift', () => {
    const result = calculateOvertimeRequestImpact(
      [
        createScheduleWithAssignmentContext({
          recordId: 'original-night-before-substitute',
          scheduleDate: '2026-08-09',
          building: 'building-a',
          team: 'shift-a',
          shift: 'night',
          dutyStaffActual: [substituteStaffName],
          dutyStaffReference: [substituteStaffName],
          personText: substituteStaffName,
        }),
        createApprovedSubstituteSchedule(),
      ],
      createSubstituteRequest(),
    );

    expect(result).toMatchObject({
      conflictingSchedules: [],
      invalidRangeReason: 'continuous_duty_24_hours',
      canSubmit: false,
    });
  });

  it('fails closed when the actual roster contains the staff member without approved substitute metadata', () => {
    const result = calculateOvertimeRequestImpact(
      [
        createScheduleWithAssignmentContext({
          recordId: 'actual-only-white',
          scheduleDate: '2026-08-10',
          shift: 'white',
          dutyStaffActual: [substituteStaffName],
          dutyStaffReference: [leaveStaffName],
          personText: leaveStaffName,
          leaveStaff: [leaveStaffName],
        }),
      ],
      createSubstituteRequest(),
    );

    expect(result.conflictingSchedules).toMatchObject([
      { recordId: 'actual-only-white', overlapHours: 8 },
    ]);
    expect(result.canSubmit).toBe(false);
  });
});

describe('long-white overtime policy', () => {
  it.each([
    '长白',
    '长白班',
    'long_white',
    'longwhite',
    'long_white_shift',
    'longwhiteshift',
    'changbai',
    'changbai_shift',
  ])('rejects workday hours for explicit alias %s', (staffShift) => {
    const result = calculateOvertimeRequestImpact(
      [],
      createRequestWithStaffShift(staffShift, {
        startAt: '2026-05-08T10:00:00+08:00',
        endAt: '2026-05-08T11:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      invalidRangeReason: 'long_white_workday_hours',
      canSubmit: false,
    });
  });

  it.each([
    [
      'before the work window',
      '2026-05-08T08:00:00+08:00',
      '2026-05-08T09:00:00+08:00',
    ],
    [
      'after the work window',
      '2026-05-08T18:00:00+08:00',
      '2026-05-08T19:00:00+08:00',
    ],
  ])('allows a request %s', (_label, startAt, endAt) => {
    const result = calculateOvertimeRequestImpact(
      [],
      createRequestWithStaffShift('长白', { startAt, endAt }),
    );

    expect(result).toMatchObject({
      conflictingSchedules: [],
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it('allows daytime overtime on an official holiday and ignores its long-white schedule row', () => {
    const result = calculateOvertimeRequestImpact(
      [
        createSchedule({
          scheduleDate: '2026-05-01',
          team: '长白',
          shift: '白班',
        }),
      ],
      createRequest({
        startAt: '2026-05-01T10:00:00+08:00',
        endAt: '2026-05-01T11:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      conflictingSchedules: [],
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it('treats an adjusted weekend workday as a workday', () => {
    const result = calculateOvertimeRequestImpact(
      [],
      createRequestWithStaffShift('长白', {
        startAt: '2026-05-09T10:00:00+08:00',
        endAt: '2026-05-09T11:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      invalidRangeReason: 'long_white_workday_hours',
      canSubmit: false,
    });
  });

  it('fails closed when a requested Shanghai date has no calendar data', () => {
    const result = calculateOvertimeRequestImpact(
      [],
      createRequestWithStaffShift('长白', {
        startAt: '2027-08-02T10:00:00+08:00',
        endAt: '2027-08-02T11:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      invalidRangeReason: 'calendar_data_missing',
      canSubmit: false,
    });
  });

  it("infers long-white only from the named staff member's recognized schedules", () => {
    const result = calculateOvertimeRequestImpact(
      [
        createSchedule({ team: '长白', shift: '白班' }),
        createSchedule({
          recordId: 'other-staff-normal-shift',
          shift: '夜班',
          dutyStaffActual: ['李四'],
        }),
      ],
      createRequest({
        startAt: '2026-08-10T10:00:00+08:00',
        endAt: '2026-08-10T11:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      invalidRangeReason: 'long_white_workday_hours',
      canSubmit: false,
    });
  });
});

describe('7x24 continuous-duty overtime policy', () => {
  it.each([
    {
      label: 'normal white shift plus four hours',
      schedule: createSchedule({
        scheduleDate: '2026-08-10',
        shift: '白班',
      }),
      startAt: '2026-08-10T18:00:00+08:00',
      endAt: '2026-08-10T22:00:00+08:00',
    },
    {
      label: 'normal night shift plus four hours',
      schedule: createSchedule({
        scheduleDate: '2026-08-10',
        shift: '夜班',
      }),
      startAt: '2026-08-11T09:00:00+08:00',
      endAt: '2026-08-11T13:00:00+08:00',
    },
    {
      label: '110 white shift plus four hours',
      schedule: createSchedule({
        scheduleDate: '2026-08-10',
        building: '110号楼',
        shift: '白班',
      }),
      startAt: '2026-08-10T20:00:00+08:00',
      endAt: '2026-08-11T00:00:00+08:00',
    },
    {
      label: '110 night shift plus four hours',
      schedule: createSchedule({
        scheduleDate: '2026-08-10',
        building: '110号楼',
        shift: '夜班',
      }),
      startAt: '2026-08-11T08:00:00+08:00',
      endAt: '2026-08-11T12:00:00+08:00',
    },
  ])('allows $label', ({ schedule, startAt, endAt }) => {
    const result = calculateOvertimeRequestImpact(
      [schedule],
      createRequest({ startAt, endAt }),
    );

    expect(result).toMatchObject({
      conflictingSchedules: [],
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it.each([
    {
      label: 'normal white shift followed by a complete night window',
      schedule: createSchedule({
        scheduleDate: '2026-08-10',
        shift: '白班',
      }),
      startAt: '2026-08-10T18:00:00+08:00',
      endAt: '2026-08-11T09:00:00+08:00',
    },
    {
      label: 'normal night shift followed by a complete white window',
      schedule: createSchedule({
        scheduleDate: '2026-08-10',
        shift: '夜班',
      }),
      startAt: '2026-08-11T09:00:00+08:00',
      endAt: '2026-08-11T18:00:00+08:00',
    },
    {
      label: '110 white shift followed by a complete 110 night window',
      schedule: createSchedule({
        scheduleDate: '2026-08-10',
        building: '110号楼',
        shift: '白班',
      }),
      startAt: '2026-08-10T20:00:00+08:00',
      endAt: '2026-08-11T08:00:00+08:00',
    },
    {
      label: '110 night shift followed by a complete 110 white window',
      schedule: createSchedule({
        scheduleDate: '2026-08-10',
        building: '110号楼',
        shift: '夜班',
      }),
      startAt: '2026-08-11T08:00:00+08:00',
      endAt: '2026-08-11T20:00:00+08:00',
    },
  ])(
    'rejects 24 continuous hours from $label',
    ({ schedule, startAt, endAt }) => {
      const result = calculateOvertimeRequestImpact(
        [schedule],
        createRequest({ startAt, endAt }),
      );

      expect(result).toMatchObject({
        conflictingSchedules: [],
        invalidRangeReason: 'continuous_duty_24_hours',
        canSubmit: false,
      });
    },
  );

  it('breaks a continuous-duty chain at a positive gap', () => {
    const result = calculateOvertimeRequestImpact(
      [createSchedule({ scheduleDate: '2026-08-10', shift: '白班' })],
      createRequest({
        startAt: '2026-08-10T19:00:00+08:00',
        endAt: '2026-08-11T09:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      conflictingSchedules: [],
      invalidRangeReason: null,
      canSubmit: true,
    });
  });

  it('rejects a standalone 24-hour request for an explicit non-long-white shift', () => {
    const result = calculateOvertimeRequestImpact(
      [],
      createRequestWithStaffShift('夜班', {
        startAt: '2026-08-10T10:00:00+08:00',
        endAt: '2026-08-11T10:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      conflictingSchedules: [],
      invalidRangeReason: 'continuous_duty_24_hours',
      canSubmit: false,
    });
  });

  it('does not count duplicate cross-building schedule intervals more than once', () => {
    const result = calculateOvertimeRequestImpact(
      [
        createSchedule({
          recordId: 'station-a',
          scheduleDate: '2026-08-10',
          building: '110-A',
          shift: '白班',
        }),
        createSchedule({
          recordId: 'station-b',
          scheduleDate: '2026-08-10',
          building: '110-B',
          shift: '白班',
        }),
      ],
      createRequest({
        startAt: '2026-08-10T20:00:00+08:00',
        endAt: '2026-08-11T00:00:00+08:00',
      }),
    );

    expect(result).toMatchObject({
      conflictingSchedules: [],
      invalidRangeReason: null,
      canSubmit: true,
    });
  });
});

describe('createOvertimeRequestImpactComparisonKey', () => {
  const impact: OvertimeRequestImpact = {
    rawHours: 4,
    payableHours: 4,
    conflictingSchedules: [
      {
        recordId: 'schedule-b',
        date: '2026-08-09',
        building: '2号楼',
        team: 'B班',
        shift: '夜班',
        overlapHours: 1,
      },
      {
        recordId: 'schedule-a',
        date: '2026-08-08',
        building: '1号楼',
        team: 'A班',
        shift: '白班',
        overlapHours: 2,
      },
    ],
    isWholeHour: true,
    invalidRangeReason: null,
    canSubmit: false,
  };

  it('is stable when equivalent conflicts arrive in another order', () => {
    const reversed = {
      ...impact,
      conflictingSchedules: [...impact.conflictingSchedules].reverse(),
    };

    expect(createOvertimeRequestImpactComparisonKey(reversed)).toBe(
      createOvertimeRequestImpactComparisonKey(impact),
    );
  });

  it('changes when a conflicting schedule changes', () => {
    const changed = {
      ...impact,
      conflictingSchedules: impact.conflictingSchedules.map(
        (schedule, index) =>
          index === 0 ? { ...schedule, overlapHours: 2 } : schedule,
      ),
    };

    expect(createOvertimeRequestImpactComparisonKey(changed)).not.toBe(
      createOvertimeRequestImpactComparisonKey(impact),
    );
  });

  it('rejects malformed impact snapshots', () => {
    expect(
      createOvertimeRequestImpactComparisonKey({
        ...impact,
        payableHours: '4',
      }),
    ).toBeNull();
  });

  it.each([
    'long_white_workday_hours',
    'continuous_duty_24_hours',
    'calendar_data_missing',
  ] as const)(
    'accepts the new invalid range reason %s',
    (invalidRangeReason) => {
      expect(
        createOvertimeRequestImpactComparisonKey({
          ...impact,
          invalidRangeReason,
        }),
      ).not.toBeNull();
    },
  );
});

describe('overtime request API contract', () => {
  it('keeps the request and canonical response bound to the shared impact', () => {
    const expectedImpact = calculateOvertimeRequestImpact([], createRequest());
    const request: OvertimeRequestCreateRequest = {
      clientMutationId: 'overtime-request-1',
      staffName: '张三',
      startAt: '2026-08-08T18:00:00+08:00',
      endAt: '2026-08-08T22:00:00+08:00',
      reason: '应急割接',
      expectedImpact,
    };
    const response: OvertimeRequestCreateResponse = {
      success: true,
      created: 1,
      recordId: 'record-1',
      clientMutationId: request.clientMutationId,
      requestFingerprint: 'fingerprint-1',
      impact: expectedImpact,
      message: '加班申请已创建',
    };

    expect(response.impact).toBe(request.expectedImpact);
  });
});
