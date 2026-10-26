import {
  calculateSubstituteOvertimeRequirement,
  type SubstituteOvertimeInterval as Interval,
  type SubstituteOvertimePolicyInput as Input,
} from '../../shared/substitute-overtime-policy';

const ms = (dateTime: string) => Date.parse(`${dateTime}:00+08:00`);
const interval = (start: string, end: string): Interval => ({
  startMs: ms(start),
  endMs: ms(end),
});
const input = (overrides: Partial<Input> = {}): Input => ({
  staff: { userId: 'staff-1', workPattern: 'rotating' },
  substitute: interval('2026-10-13T09:00', '2026-10-13T18:00'),
  schedules: [],
  applications: [],
  ...overrides,
});
const evaluate = calculateSubstituteOvertimeRequirement;

describe('substitute overtime requirement', () => {
  it.each(['2026-10-13', '2026-10-10'])(
    'does not require overtime for own long-white duty on workday %s',
    (date) => {
      expect(
        evaluate(
          input({
            staff: { userId: 'staff-1', workPattern: 'long_white' },
            substitute: interval(`${date}T09:00`, `${date}T18:00`),
          }),
        ),
      ).toMatchObject({
        status: 'not_required',
        overtimeHours: 0,
        unappliedHours: 0,
      });
    },
  );

  it('does not infer own long-white membership from the replaced shift', () => {
    expect(evaluate(input())).toMatchObject({
      status: 'required',
      overtimeHours: 8,
      unappliedHours: 8,
    });
  });

  it('requires daytime overtime on a long-white rest day', () => {
    expect(
      evaluate(
        input({
          staff: { userId: 'staff-1', workPattern: 'long_white' },
          substitute: interval('2026-10-11T09:00', '2026-10-11T18:00'),
        }),
      ),
    ).toMatchObject({ status: 'required', overtimeHours: 8 });
  });

  it('keeps only hours outside the long-white work window', () => {
    const result = evaluate(
      input({
        staff: { userId: 'staff-1', workPattern: 'long_white' },
        substitute: interval('2026-10-13T08:00', '2026-10-13T19:00'),
      }),
    );
    expect(result).toMatchObject({
      status: 'required',
      overtimeHours: 2,
      unappliedHours: 2,
    });
    expect(result.unappliedIntervals).toEqual([
      interval('2026-10-13T08:00', '2026-10-13T09:00'),
      interval('2026-10-13T18:00', '2026-10-13T19:00'),
    ]);
  });

  it('excludes own original duty even across buildings and duplicate intervals', () => {
    const duty = {
      ...input().substitute,
      staffUserId: 'staff-1',
      source: 'original' as const,
    };
    expect(evaluate(input({ schedules: [duty, duty] }))).toMatchObject({
      status: 'not_required',
      overtimeHours: 0,
    });
  });

  it('unions touching and overlapping original intervals before subtraction', () => {
    expect(
      evaluate(
        input({
          schedules: [
            {
              ...interval('2026-10-13T09:00', '2026-10-13T14:00'),
              staffUserId: 'staff-1',
              source: 'original',
            },
            {
              ...interval('2026-10-13T13:00', '2026-10-13T17:00'),
              staffUserId: 'staff-1',
              source: 'original',
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: 'required',
      overtimeHours: 1,
      unappliedIntervals: [interval('2026-10-13T17:00', '2026-10-13T18:00')],
    });
  });

  it('uses only own duty, not another employee original roster', () => {
    expect(
      evaluate(
        input({
          schedules: [
            {
              ...input().substitute,
              staffUserId: 'other-staff',
              source: 'original',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'required', overtimeHours: 8 });
  });

  it('does not count the substituted actual assignment as original duty', () => {
    expect(
      evaluate(
        input({
          schedules: [
            {
              ...input().substitute,
              staffUserId: 'staff-1',
              source: 'substitute',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'required', overtimeHours: 8 });
  });

  it('does not infer original duty from actual-only roster data', () => {
    expect(
      evaluate(
        input({
          schedules: [
            {
              ...input().substitute,
              staffUserId: 'staff-1',
              source: 'actual',
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: 'needs_review',
      reason: 'original_schedule_unverified',
    });
  });

  it('subtracts an original night shift across midnight', () => {
    expect(
      evaluate(
        input({
          substitute: interval('2026-10-14T08:00', '2026-10-14T11:00'),
          schedules: [
            {
              ...interval('2026-10-13T18:00', '2026-10-14T09:00'),
              staffUserId: 'staff-1',
              source: 'original',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'required', overtimeHours: 2 });
  });

  it('splits a cross-day long-white substitution by Shanghai work dates', () => {
    expect(
      evaluate(
        input({
          staff: { userId: 'staff-1', workPattern: 'long_white' },
          substitute: interval('2026-10-10T17:00', '2026-10-11T10:00'),
        }),
      ),
    ).toMatchObject({ status: 'required', overtimeHours: 16 });
  });

  it.each(['pending', 'approved'] as const)(
    'suppresses a fully covered %s application',
    (status) => {
      expect(
        evaluate(
          input({
            applications: [
              {
                ...input().substitute,
                staffUserId: 'staff-1',
                status,
              },
            ],
          }),
        ),
      ).toMatchObject({
        status: 'already_applied',
        overtimeHours: 8,
        unappliedHours: 0,
      });
    },
  );

  it('subtracts only the applied portion after normal duty', () => {
    expect(
      evaluate(
        input({
          schedules: [
            {
              ...interval('2026-10-13T09:00', '2026-10-13T16:00'),
              staffUserId: 'staff-1',
              source: 'original',
            },
          ],
          applications: [
            {
              ...interval('2026-10-13T16:00', '2026-10-13T17:00'),
              staffUserId: 'staff-1',
              status: 'approved',
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: 'required',
      overtimeHours: 2,
      unappliedHours: 1,
      unappliedIntervals: [interval('2026-10-13T17:00', '2026-10-13T18:00')],
    });
  });

  it.each(['rejected', 'cancelled'] as const)(
    'does not suppress a %s application',
    (status) => {
      expect(
        evaluate(
          input({
            applications: [
              { ...input().substitute, staffUserId: 'staff-1', status },
            ],
          }),
        ),
      ).toMatchObject({ status: 'required', unappliedHours: 8 });
    },
  );

  it('does not use another person application to suppress a reminder', () => {
    expect(
      evaluate(
        input({
          applications: [
            {
              ...input().substitute,
              staffUserId: 'other-staff',
              status: 'approved',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'required', unappliedHours: 8 });
  });

  it.each([
    [{ staff: null }, 'staff_data_missing'],
    [
      { staff: { userId: '', workPattern: 'long_white' } },
      'staff_data_missing',
    ],
    [{ schedules: null }, 'schedule_data_missing'],
    [{ applications: null }, 'application_data_missing'],
    [
      { substitute: { startMs: Number.NaN, endMs: ms('2026-10-13T18:00') } },
      'invalid_interval',
    ],
    [
      {
        substitute: {
          startMs: ms('2026-10-13T18:00'),
          endMs: ms('2026-10-13T09:00'),
        },
      },
      'invalid_interval',
    ],
  ] as Array<[Partial<Input>, string]>)(
    'fails explicitly for incomplete or invalid input %#',
    (overrides, reason) => {
      expect(evaluate(input(overrides))).toMatchObject({
        status: 'needs_review',
        reason,
        unappliedIntervals: [],
      });
    },
  );

  it('fails explicitly when long-white workday data is unavailable', () => {
    expect(
      evaluate(
        input({
          staff: { userId: 'staff-1', workPattern: 'long_white' },
          substitute: interval('2027-10-13T09:00', '2027-10-13T18:00'),
        }),
      ),
    ).toMatchObject({
      status: 'needs_review',
      reason: 'calendar_data_missing',
    });
  });

  it('excludes unpaid lunch without requiring an overtime application', () => {
    expect(
      evaluate(
        input({ substitute: interval('2026-10-13T12:00', '2026-10-13T13:00') }),
      ),
    ).toMatchObject({
      status: 'not_required',
      overtimeHours: 0,
      unappliedHours: 0,
    });
  });

  it('requires long-white daytime overtime on an official holiday', () => {
    expect(
      evaluate(
        input({
          staff: { userId: 'staff-1', workPattern: 'long_white' },
          substitute: interval('2026-10-01T09:00', '2026-10-01T18:00'),
        }),
      ),
    ).toMatchObject({ status: 'required', overtimeHours: 8 });
  });

  it('does not silently accept an unknown application state', () => {
    expect(
      evaluate(
        input({
          applications: [
            {
              ...input().substitute,
              staffUserId: 'staff-1',
              status: 'unknown' as never,
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: 'needs_review',
      reason: 'application_state_unknown',
      overtimeHours: null,
      unappliedHours: null,
    });
  });

  it('does not silently accept an unknown personnel work pattern', () => {
    expect(
      evaluate(
        input({
          staff: { userId: 'staff-1', workPattern: 'unknown' as never },
        }),
      ),
    ).toMatchObject({ status: 'needs_review', reason: 'staff_data_missing' });
  });

  it.each(['schedules', 'applications'] as const)(
    'rejects invalid own intervals in %s',
    (field) => {
      const broken = {
        startMs: Number.NaN,
        endMs: Number.POSITIVE_INFINITY,
        staffUserId: 'staff-1',
      };
      const overrides =
        field === 'schedules'
          ? { schedules: [{ ...broken, source: 'original' as const }] }
          : { applications: [{ ...broken, status: 'approved' as const }] };
      expect(evaluate(input(overrides))).toMatchObject({
        status: 'needs_review',
        reason: 'invalid_interval',
      });
    },
  );

  it('bounds corrupt multi-year input before iterating', () => {
    expect(
      evaluate(
        input({ substitute: interval('2026-01-01T09:00', '2028-01-01T18:00') }),
      ),
    ).toMatchObject({ status: 'needs_review', reason: 'invalid_interval' });
  });

  it('unions applications and does not mutate cached snapshots', () => {
    const value = input({
      applications: [
        {
          ...interval('2026-10-13T13:00', '2026-10-13T18:00'),
          staffUserId: 'staff-1',
          status: 'approved',
        },
        {
          ...interval('2026-10-13T09:00', '2026-10-13T14:00'),
          staffUserId: 'staff-1',
          status: 'pending',
        },
      ],
    });
    const before = JSON.stringify(value);
    expect(evaluate(value)).toMatchObject({
      status: 'already_applied',
      overtimeHours: 8,
      unappliedHours: 0,
    });
    expect(JSON.stringify(value)).toBe(before);
  });
});
