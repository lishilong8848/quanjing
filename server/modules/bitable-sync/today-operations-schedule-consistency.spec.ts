import { detectTodayOperationsScheduleConsistencyIssues } from './today-operations-schedule-consistency';

describe('detectTodayOperationsScheduleConsistencyIssues', () => {
  const nightShift = {
    recordId: 'rec_schedule_a_night_20260822',
    scheduleDate: '2026-08-22',
    building: 'A栋',
    shift: '夜班',
    startAt: '2026-08-22T18:00:00+08:00',
    endAt: '2026-08-23T09:00:00+08:00',
    plannedStaff: ['李董'],
    actualStaff: ['李董'],
    approvedLeaveStaff: [],
    approvedSubstituteStaff: [],
  };

  it('reports only the substitute assigned to the exact schedule record', () => {
    const otherShift = {
      ...nightShift,
      recordId: 'rec_schedule_b_night_20260822',
      building: 'B栋',
      actualStaff: ['王五'],
    };
    const issues = detectTodayOperationsScheduleConsistencyIssues({
      schedules: [{ ...nightShift, actualStaff: ['赵六'] }, otherShift],
      approvedLeaveAssignments: [
        {
          sourceRecordId: 'rec_leave_lidong',
          scheduleRecordId: nightShift.recordId,
          shiftKey: '2026-08-22|A栋|夜班',
          leaveStaff: [],
          substituteStaff: ['周庆庆'],
        },
      ],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'approved_substitute_missing',
          scheduleRecordId: nightShift.recordId,
          sourceRecordId: 'rec_leave_lidong',
          scope: '2026-08-22 A栋 夜班',
          details: expect.arrayContaining([
            '已审批替班人员“周庆庆”未出现在该班次实际排班中',
            '当前实际人员：赵六',
            '已审批请假人员：无',
            '已审批替班人员：周庆庆',
          ]),
        }),
      ]),
    );
    expect(
      issues.some((issue) => issue.scheduleRecordId === otherShift.recordId),
    ).toBe(false);
  });

  it('does not infer a substitute requirement without an approved leave assignment', () => {
    expect(
      detectTodayOperationsScheduleConsistencyIssues({
        schedules: [nightShift],
        approvedLeaveAssignments: [],
      }),
    ).toEqual([]);
  });

  it('does not report a substitute already present in the actual schedule', () => {
    const issues = detectTodayOperationsScheduleConsistencyIssues({
      schedules: [{ ...nightShift, actualStaff: ['周庆庆'] }],
      approvedLeaveAssignments: [
        {
          sourceRecordId: 'rec_leave_lidong',
          scheduleRecordId: nightShift.recordId,
          shiftKey: '2026-08-22|A栋|夜班',
          leaveStaff: ['李董'],
          substituteStaff: ['周庆庆'],
        },
      ],
    });

    expect(issues).toEqual([]);
  });

  it('reports an approved leave applicant who still appears in the actual schedule', () => {
    const issues = detectTodayOperationsScheduleConsistencyIssues({
      schedules: [nightShift],
      approvedLeaveAssignments: [
        {
          sourceRecordId: 'rec_leave_lidong',
          scheduleRecordId: nightShift.recordId,
          shiftKey: '2026-08-22|A栋|夜班',
          leaveStaff: ['李董'],
          substituteStaff: [],
        },
      ],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'approved_leave_still_scheduled',
          scheduleRecordId: nightShift.recordId,
          sourceRecordId: 'rec_leave_lidong',
          scope: '2026-08-22 A栋 夜班',
          details: [
            '已审批请假人员“李董”仍出现在该班次实际排班中',
            '当前实际人员：李董',
            '已审批替班人员：无',
          ],
        }),
      ]),
    );
  });

  it('combines paired leave and substitute mismatches for the same schedule', () => {
    const issues = detectTodayOperationsScheduleConsistencyIssues({
      schedules: [nightShift],
      approvedLeaveAssignments: [
        {
          sourceRecordId: 'rec_leave_lidong',
          scheduleRecordId: nightShift.recordId,
          shiftKey: '2026-08-22|A栋|夜班',
          leaveStaff: ['李董'],
          substituteStaff: ['周庆庆'],
        },
      ],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'approved_leave_substitute_mismatch',
        details: expect.arrayContaining([
          '仍在排班的请假人员：李董',
          '未进入排班的替班人员：周庆庆',
          '当前实际人员：李董',
        ]),
      }),
    ]);
  });

  it('waits for the shift start grace period before reporting a schedule mismatch', () => {
    const whiteShift = {
      ...nightShift,
      recordId: 'rec_schedule_b_white_20260904',
      scheduleDate: '2026-09-04',
      building: 'B栋',
      shift: '白班',
      startAt: '2026-09-04T09:00:00+08:00',
      endAt: '2026-09-04T18:00:00+08:00',
      plannedStaff: ['顾晓磊', '李松奇'],
      actualStaff: ['顾晓磊', '李松奇'],
    };
    const approvedLeaveAssignments = [
      {
        sourceRecordId: 'rec_leave_guxiaolei',
        scheduleRecordId: whiteShift.recordId,
        shiftKey: '2026-09-04|B栋|白班',
        leaveStaff: ['顾晓磊'],
        substituteStaff: ['周庆庆'],
        effectiveAt: '2026-09-04T08:05:46+08:00',
      },
    ];

    expect(
      detectTodayOperationsScheduleConsistencyIssues({
        schedules: [whiteShift],
        approvedLeaveAssignments,
        detectedAt: '2026-09-04T08:30:18+08:00',
        syncGraceMs: 10 * 60_000,
      }),
    ).toEqual([]);
    expect(
      detectTodayOperationsScheduleConsistencyIssues({
        schedules: [whiteShift],
        approvedLeaveAssignments,
        detectedAt: '2026-09-04T09:05:00+08:00',
        syncGraceMs: 10 * 60_000,
      }),
    ).toEqual([]);
    expect(
      detectTodayOperationsScheduleConsistencyIssues({
        schedules: [whiteShift],
        approvedLeaveAssignments,
        detectedAt: '2026-09-04T09:11:00+08:00',
        syncGraceMs: 10 * 60_000,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'approved_leave_substitute_mismatch',
      }),
    ]);
  });
});
