import {
  dedupeTodayAttendanceEntries,
  getTodayAttendanceFinalTasks,
  getTodayAttendanceTaskScheduledAt,
  getTodayAttendanceTasks,
  resolveTodayAttendanceFinalTask,
} from '../../server/modules/duty-schedule/today-attendance.tasks';

describe('today attendance task selection', () => {
  it.each([
    ['2026-08-31T00:54:59.000Z', []],
    ['2026-08-31T00:55:00.000Z', ['morning-on-duty-reminder']],
    ['2026-08-31T01:05:00.000Z', ['morning-on-duty-reminder']],
    [
      '2026-08-31T01:30:00.000Z',
      ['morning-on-duty-reminder', 'morning-off-duty-check'],
    ],
    [
      '2026-08-31T09:54:59.000Z',
      ['morning-on-duty-reminder', 'morning-off-duty-check'],
    ],
    [
      '2026-08-31T09:55:00.000Z',
      [
        'morning-on-duty-reminder',
        'morning-off-duty-check',
        'evening-on-duty-reminder',
      ],
    ],
    [
      '2026-08-31T10:04:59.000Z',
      [
        'morning-on-duty-reminder',
        'morning-off-duty-check',
        'evening-on-duty-reminder',
      ],
    ],
    [
      '2026-08-31T10:05:00.000Z',
      [
        'morning-on-duty-reminder',
        'morning-off-duty-check',
        'evening-on-duty-reminder',
      ],
    ],
    [
      '2026-08-31T10:35:00.000Z',
      [
        'morning-on-duty-reminder',
        'morning-off-duty-check',
        'evening-on-duty-reminder',
        'evening-off-duty-check',
      ],
    ],
  ])('selects due tasks at %s', (now, expected) => {
    expect(getTodayAttendanceTasks(new Date(now))).toEqual(expected);
  });

  it.each([
    ['2026-08-31T01:29:59.000Z', []],
    ['2026-08-31T01:30:00.000Z', ['morning-off-duty-check']],
    ['2026-08-31T10:34:59.000Z', ['morning-off-duty-check']],
    [
      '2026-08-31T10:35:00.000Z',
      ['morning-off-duty-check', 'evening-off-duty-check'],
    ],
  ])('selects final page checks at %s', (now, expected) => {
    expect(getTodayAttendanceFinalTasks(new Date(now))).toEqual(expected);
  });

  it('deduplicates entries by the stable expectation key', () => {
    const entries = [
      {
        key: '2026-08-31:building_a:white:OnDuty:示例人员008',
        name: '示例人员008',
        building: 'A楼',
        shiftLabel: '白班',
        direction: 'OnDuty' as const,
        expectedAt: '2026-08-31 09:00:00',
        status: 'anomaly' as const,
        reason: '未查询到有效打卡',
      },
      {
        key: '2026-08-31:building_a:white:OnDuty:示例人员008',
        name: '示例人员008',
        building: 'A楼',
        shiftLabel: '白班',
        direction: 'OnDuty' as const,
        expectedAt: '2026-08-31 09:00:00',
        status: 'normal' as const,
      },
    ];

    expect(dedupeTodayAttendanceEntries(entries)).toEqual([entries[1]]);
  });

  it('builds the persisted final-check time in Asia/Shanghai', () => {
    expect(
      getTodayAttendanceTaskScheduledAt(
        'morning-off-duty-check',
        '2026-09-12',
      ).toISOString(),
    ).toBe('2026-09-12T01:30:00.000Z');
    expect(
      getTodayAttendanceTaskScheduledAt(
        'evening-off-duty-check',
        '2026-09-12',
      ).toISOString(),
    ).toBe('2026-09-12T10:35:00.000Z');
  });

  it('keeps an explicitly requested 09:30 final check selectable after 18:35', () => {
    const now = new Date('2026-09-15T11:00:00.000Z');

    expect(resolveTodayAttendanceFinalTask(now)).toBe('evening-off-duty-check');
    expect(resolveTodayAttendanceFinalTask(now, 'morning-off-duty-check')).toBe(
      'morning-off-duty-check',
    );
  });

  it('does not select an explicitly requested final check before it is due', () => {
    expect(
      resolveTodayAttendanceFinalTask(
        new Date('2026-09-15T01:00:00.000Z'),
        'morning-off-duty-check',
      ),
    ).toBeNull();
  });
});
