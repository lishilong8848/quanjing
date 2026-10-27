import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
  deduplicateScheduleDateKeysByMonth,
  getAdjacentScheduleMonthDateKeys,
  getLeaveScheduleCoverageDateKeys,
  resolveLeaveScheduleForceRefresh,
} from '../../client/src/pages/MonthlySchedule/leave-request-schedule-coverage';
import { createScheduleReadCache } from '../../client/src/pages/MonthlySchedule/schedule-read-cache';
import { createLeaveRequestTimeCandidates } from '../../shared/leave-request-impact';
import type { MonthlyScheduleResponse } from '../../shared/api.interface';

const pageSource = readFileSync(
  join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
  'utf8',
);

function expectRequestedMonths(calls: number[][], expected: number[][]): void {
  const ordered = (months: number[][]) =>
    months
      .slice()
      .sort(
        ([leftYear, leftMonth], [rightYear, rightMonth]) =>
          leftYear - rightYear || leftMonth - rightMonth,
      );
  expect(calls.every((args) => args.length === 2)).toBe(true);
  expect(ordered(calls)).toEqual(ordered(expected));
}

// Execute the actual page callback, including cache selection and request generations.
function pageLoader(businessDateKey = '2026-10-15', gate?: Promise<void>) {
  const read = jest.fn(
    async (year: number, month: number): Promise<MonthlyScheduleResponse> => {
      await gate;
      return {
        schedules: [
          {
            id: `synthetic-${year}-${month}`,
            recordId: `synthetic-${year}-${month}`,
            scheduleDate: `${year}-${String(month).padStart(2, '0')}-15`,
            building: 'A楼',
            buildingText: 'A楼',
            team: 'A班',
            teamText: 'A班',
            shift: '白班',
            shiftText: '白班',
            dutyStaffActual: ['合成员工'],
            actualDutyStaff: '合成员工',
            personText: '合成员工',
            dutyStaffReference: [],
            dutyCode: null,
            code: null,
            remark: '',
            emergencyDuty: '',
            emergencyDutySchedule: '',
            leaveStaff: [],
            substituteStaff: [],
            createdAt: '',
            updatedAt: '',
          },
        ],
      };
    },
  );
  const scope = createScheduleReadCache(read)('synthetic-signed-user');
  const context = {
    useCallback: (callback: unknown) => callback,
    access: { isLoading: false },
    businessDateKey,
    selectedDate: new Date(2026, 9, 15),
    getAdjacentScheduleMonthDateKeys,
    deduplicateScheduleDateKeysByMonth,
    setScreenshotSectionState: jest.fn(),
    setLoading: jest.fn(),
    setSchedules: jest.fn(),
    scheduleLoadSeqRef: { current: 0 },
    monthlyScheduleCache: scope.cache,
    scheduleReadScope: scope,
    activeScheduleReadScopeRef: { current: scope },
    scheduleMonthRequestGenerationRef: { current: new Map<string, number>() },
    scheduleMonthForceRefreshGenerationRef: {
      current: new Map<string, number>(),
    },
    getMonthlySchedulesWithInFlightDeduplication: scope.read,
    logger: { warn: jest.fn(), error: jest.fn() },
    toast: { error: jest.fn() },
  };
  const start = pageSource.indexOf('  const loadSchedules = useCallback(');
  const end = pageSource.indexOf('  const loadSchedulesRef =', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const constants = ['LOCAL_DATA_CACHE_TTL_MS', 'MONTHLY_SCHEDULE_CACHE_TTL_MS']
    .map((name) => {
      const match = pageSource.match(new RegExp(`const ${name} = [^;]+;`));
      expect(match).not.toBeNull();
      return match![0];
    })
    .join('\n');
  const compiled = transpileModule(
    `${constants}\n${pageSource.slice(start, end)}\nloadSchedules;`,
    {
      compilerOptions: {
        module: ModuleKind.CommonJS,
        target: ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const load = runInNewContext(compiled, context) as (options?: {
    additionalDateKeys?: string[];
  }) => Promise<boolean>;
  return { context, load, read, scope };
}

describe('fixed three-month schedule coverage', () => {
  it.each([
    ['2026-10-01', ['2026-09-01', '2026-10-01', '2026-11-01']],
    ['2026-10-15', ['2026-09-01', '2026-10-01', '2026-11-01']],
    ['2026-10-31', ['2026-09-01', '2026-10-01', '2026-11-01']],
    ['2026-01-01', ['2025-12-01', '2026-01-01', '2026-02-01']],
    ['2026-01-31', ['2025-12-01', '2026-01-01', '2026-02-01']],
    ['2026-12-01', ['2026-11-01', '2026-12-01', '2027-01-01']],
    ['2026-12-31', ['2026-11-01', '2026-12-01', '2027-01-01']],
    ['2024-02-29', ['2024-01-01', '2024-02-01', '2024-03-01']],
    ['2026-02-28', ['2026-01-01', '2026-02-01', '2026-03-01']],
  ])('returns whole adjacent months for business day %s', (day, expected) => {
    expect(getAdjacentScheduleMonthDateKeys(day as string)).toEqual(expected);
    expect(getLeaveScheduleCoverageDateKeys(day as string, '', '')).toEqual(
      expected,
    );
  });

  it.each(['', 'invalid', '2026-13-01', '2026-02-30', '2026-02-29'])(
    'does not turn invalid business date %j into a different month',
    (day) => expect(getAdjacentScheduleMonthDateKeys(day)).toEqual([]),
  );

  it('adds a historical range and its overnight boundary without dropping fixed months', () => {
    expect(
      getLeaveScheduleCoverageDateKeys(
        '2026-10-15',
        '2026-01-01T00:00',
        '2026-01-03T18:00',
      ),
    ).toEqual([
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2025-12-01',
      '2026-01-01',
    ]);
  });

  it('adds all months of an explicit cross-year range once', () => {
    const dates = getLeaveScheduleCoverageDateKeys(
      '2026-10-15',
      '2026-11-15T09:00',
      '2027-02-05T18:00',
    );
    expect(dates).toEqual([
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
    expect(
      deduplicateScheduleDateKeysByMonth([
        ...dates,
        '2026-10-31',
        '2027-02-01',
      ]),
    ).toEqual(dates);
  });

  it.each([
    ['2026-09-15T09:00', '2026-11-20T18:00'],
    ['2026-10-15T09:00', '2026-10-16T18:00'],
    ['2026-11-20T18:00', '2026-09-15T09:00'],
  ])(
    'does not add months for an overlapping or invalid range %s to %s',
    (start, end) => {
      expect(
        getLeaveScheduleCoverageDateKeys('2026-10-15', start, end),
      ).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    },
  );

  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])(
    'preserves requested=%s and permitted=%s force-refresh rules',
    (requested, permitted, expected) => {
      expect(resolveLeaveScheduleForceRefresh(requested, permitted)).toBe(
        expected,
      );
    },
  );

  it('loads three months once, then reuses cache for same-month date switches and overlapping leave choices', async () => {
    const { context, load, read, scope } = pageLoader();
    expect(await load()).toBe(true);
    expectRequestedMonths(read.mock.calls, [
      [2026, 9],
      [2026, 10],
      [2026, 11],
    ]);
    context.selectedDate = new Date(2026, 9, 31);
    expect(await load()).toBe(true);
    const rows = [...scope.cache.values()].flatMap(
      ({ schedules }) => schedules,
    );
    const candidates = createLeaveRequestTimeCandidates(rows, {
      leaveStaffName: '合成员工',
    });
    expect(candidates.startOptions.length).toBeGreaterThan(0);
    const range = candidates.fullShiftRanges.find(({ startAt }) =>
      startAt.startsWith('2026-10'),
    )!;
    expect(range).toBeDefined();
    const coverage = getLeaveScheduleCoverageDateKeys(
      context.businessDateKey,
      range.startAt,
      range.endAt,
    );
    expect(await load({ additionalDateKeys: coverage })).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every((args) => args.length === 2)).toBe(true);
  });

  it('adds only one month for a historical selection in the middle of its month', async () => {
    const { context, load, read } = pageLoader();
    context.selectedDate = new Date(2025, 0, 15);
    expect(await load()).toBe(true);
    expectRequestedMonths(read.mock.calls, [
      [2026, 9],
      [2026, 10],
      [2026, 11],
      [2025, 1],
    ]);
    context.selectedDate = new Date(2025, 0, 16);
    expect(await load()).toBe(true);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it.each<[Date, number[][]]>([
    [
      new Date(2025, 0, 1),
      [
        [2024, 12],
        [2025, 1],
      ],
    ],
    [
      new Date(2025, 0, 31),
      [
        [2025, 1],
        [2025, 2],
      ],
    ],
  ])(
    'retains a historical overview that crosses a month boundary on %s',
    async (selectedDate, extraMonths) => {
      const { context, load, read } = pageLoader();
      context.selectedDate = selectedDate;
      expect(await load()).toBe(true);
      expectRequestedMonths(read.mock.calls, [
        [2026, 9],
        [2026, 10],
        [2026, 11],
        ...extraMonths,
      ]);
    },
  );

  it('fetches only genuinely additional months and deduplicates repeated explicit dates', async () => {
    const { load, read } = pageLoader();
    expect(await load()).toBe(true);
    expect(
      await load({
        additionalDateKeys: [
          '2026-11-15',
          '2026-12-01',
          '2026-12-31',
          '2027-01-01',
          '2027-01-15',
        ],
      }),
    ).toBe(true);
    expectRequestedMonths(read.mock.calls, [
      [2026, 9],
      [2026, 10],
      [2026, 11],
      [2026, 12],
      [2027, 1],
    ]);
  });

  it('deduplicates the three in-flight reads across concurrent page loads', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { load, read } = pageLoader('2026-10-15', gate);
    const first = load();
    const second = load();
    expect(read).toHaveBeenCalledTimes(3);
    release();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('cached schedule merge identity', () => {
  type Row = {
    recordId: string;
    id: string;
    scheduleDate: string;
    building: string;
    team: string;
    shift: string;
    dutyStaffActual: string[];
  };
  const row = (recordId: string, overrides: Partial<Row> = {}): Row => ({
    recordId,
    id: recordId,
    scheduleDate: '2026-10-15',
    building: 'A楼',
    team: 'A班',
    shift: '白班',
    dutyStaffActual: ['合成员工'],
    ...overrides,
  });
  const mergeStart = pageSource.indexOf('function mergeSchedulesByRecord(');
  const mergeEnd = pageSource.indexOf(
    'function getMonthEndDateKey(',
    mergeStart,
  );
  const merge = (): ((current: Row[], incoming: Row[]) => Row[]) => {
    expect(mergeStart).toBeGreaterThan(-1);
    expect(mergeEnd).toBeGreaterThan(mergeStart);
    const compiled = transpileModule(
      `${pageSource.slice(mergeStart, mergeEnd)}\nmergeSchedulesByRecord;`,
      {
        compilerOptions: {
          module: ModuleKind.CommonJS,
          target: ScriptTarget.ES2022,
        },
      },
    ).outputText;
    return runInNewContext(compiled, {});
  };

  it('preserves the existing array for overlapping cached references and empty incoming rows', () => {
    const first = row('first'),
      second = row('second');
    const current = [first, second],
      empty: Row[] = [];
    const mergeRows = merge();
    expect(mergeRows(current, [second, first])).toBe(current);
    expect(mergeRows(current, [second])).toBe(current);
    expect(mergeRows(current, [])).toBe(current);
    expect(mergeRows(empty, [])).toBe(empty);
    expect(current).toEqual([first, second]);
  });

  it('returns a new array for replaced and new rows while preserving unrelated records and source arrays', () => {
    const first = row('first'),
      second = row('second');
    const updated = row('first', { dutyStaffActual: ['更新人员'] });
    const added = row('third', { scheduleDate: '2026-11-15' });
    const current = [first, second],
      incoming = [updated, added];
    const result = merge()(current, incoming);
    expect(result).not.toBe(current);
    expect(result).toEqual([updated, second, added]);
    expect(result[0]).toBe(updated);
    expect(result[1]).toBe(second);
    expect(result[2]).toBe(added);
    expect(current).toEqual([first, second]);
    expect(incoming).toEqual([updated, added]);
  });

  it('does not swallow a fresh row object even when every field is equal', () => {
    const original = row('first');
    const equivalent = {
      ...original,
      dutyStaffActual: [...original.dutyStaffActual],
    };
    const current = [original];
    const result = merge()(current, [equivalent]);
    expect(equivalent).toEqual(original);
    expect(result).not.toBe(current);
    expect(result[0]).toBe(equivalent);
  });

  it('still removes duplicate keys and returns a new array when the row count changes', () => {
    const first = row('first'),
      replacement = row('first', { dutyStaffActual: ['最后一条'] });
    const second = row('second');
    const current = [first, replacement, second];
    const result = merge()(current, []);
    expect(result).not.toBe(current);
    expect(result).toEqual([replacement, second]);
    expect(result[0]).toBe(replacement);
    expect(current).toHaveLength(3);
  });

  it('keeps date/building/team/shift fallback keys separate for records without IDs', () => {
    const first = row('');
    const others = [
      row('', { scheduleDate: '2026-10-16' }),
      row('', { building: 'B楼' }),
      row('', { team: 'B班' }),
      row('', { shift: '夜班' }),
    ];
    const updated = row('', { dutyStaffActual: ['更新人员'] });
    const current = [first, ...others];
    const result = merge()(current, [updated]);
    expect(result).not.toBe(current);
    expect(result).toEqual([updated, ...others]);
    expect(result.slice(1).every((item, index) => item === others[index])).toBe(
      true,
    );
  });

  it('retains other months and rows through both actual repair and leave-coverage callbacks', async () => {
    for (const [name, endMarker] of [
      [
        'ensureSchedulesForRepairDate',
        'const ensureSchedulesForLeaveDateRange',
      ],
      ['ensureSchedulesForLeaveDateRange', 'const loadSealingInfo'],
    ]) {
      const retained = row('prior-month', { scheduleDate: '2026-09-15' });
      const original = row('current');
      const updated = row('current', { dutyStaffActual: ['更新人员'] });
      const added = row('added', { scheduleDate: '2026-10-16' });
      let schedules = [retained, original];
      const loadDate = jest.fn(async () => [updated, added]);
      const start = pageSource.indexOf(`const ${name} = useCallback(`);
      const end = pageSource.indexOf(endMarker, start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const keyStart = pageSource.indexOf('function getScheduleMonthKey(');
      const source = `${pageSource.slice(keyStart, mergeStart)}\n${pageSource.slice(start, end)}\n${name};`;
      const compiled = transpileModule(source, {
        compilerOptions: {
          module: ModuleKind.CommonJS,
          target: ScriptTarget.ES2022,
        },
      }).outputText;
      const callback = runInNewContext(compiled, {
        useCallback: (fn: unknown) => fn,
        loadSchedulesForDate: loadDate,
        mergeSchedulesByRecord: merge(),
        deduplicateScheduleDateKeysByMonth,
        repairScheduleLoadSeqRef: { current: 0 },
        setRepairDateLoading: jest.fn(),
        scheduleMonthForceRefreshGenerationRef: { current: new Map() },
        toast: { error: jest.fn() },
        setSchedules: (update: (current: Row[]) => Row[]) => {
          schedules = update(schedules);
        },
      }) as (dates: string | string[]) => Promise<boolean>;
      expect(
        await callback(
          name === 'ensureSchedulesForRepairDate'
            ? '2026-10-16'
            : ['2026-10-01', '2026-10-16'],
        ),
      ).toBe(true);
      expect(loadDate).toHaveBeenCalledTimes(1);
      expect(schedules).toEqual([retained, updated, added]);
      expect(schedules[0]).toBe(retained);
      expect(schedules[1]).toBe(updated);
    }
  });
});
