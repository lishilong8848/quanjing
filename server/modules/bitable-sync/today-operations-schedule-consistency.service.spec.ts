import type { LeaveApprovalSnapshot } from '@server/common/feishu/leave-approval-source';
import { buildTodayOperationsScheduleConsistencySnapshot } from './today-operations-schedule-consistency.service';

describe('buildTodayOperationsScheduleConsistencySnapshot', () => {
  const scheduleRecord = {
    record_id: 'rec_schedule_a_night_20260822',
    fields: {
      排班日期: '2026-08-22',
      机楼: 'A楼',
      班组: 'A班',
      班次: '夜班',
      '人员（文本）': '李董',
      '值班人员（实际）程序修改': '李董',
      '请假人员（请假表）': '李董',
      '替班人员（请假表）': '周庆庆',
    },
  };
  const leaveApproval: LeaveApprovalSnapshot = {
    verified: true,
    requests: [
      {
        recordId: 'rec_leave_lidong',
        leaveStaff: ['李董'],
        substituteStaff: ['周庆庆'],
        startAt: '2026-08-22 18:00',
        endAt: '2026-08-23 09:00',
        building: 'A楼',
        team: 'A班',
        shift: '夜班',
        impactedScheduleRecordIds: ['rec_schedule_a_night_20260822'],
      },
    ],
  };

  it('maps the current revision substitute to its exact schedule record', () => {
    const issues = buildTodayOperationsScheduleConsistencySnapshot({
      businessDate: '2026-08-23',
      scheduleRecords: [scheduleRecord],
      overtimeRecords: [
        {
          record_id: 'rec_overtime_zhouqingqing',
          fields: {
            加班人员姓名: '周庆庆',
            加班开始时间: Date.parse('2026-08-22T18:00:00+08:00'),
            加班结束时间: Date.parse('2026-08-23T09:00:00+08:00'),
            加班原因: '替李董上A楼夜班',
            机楼: '110站',
            加班工作流状态: '已审批',
          },
        },
      ],
      leaveApproval: {
        ...leaveApproval,
        requests: [
          {
            ...leaveApproval.requests[0],
            assignmentRevision: 2,
            shiftDetails: [
              {
                shiftKey: '2026-08-22|A栋|夜班',
                scheduleRecordIds: ['rec_schedule_a_night_20260822'],
                substituteStaff: ['周庆庆'],
                revision: 2,
              },
            ],
          },
        ],
      },
    });

    expect(issues.map((issue) => issue.kind)).toEqual([
      'approved_leave_substitute_mismatch',
    ]);
  });

  it('does not treat an ordinary approved overtime record as a substitute assignment', () => {
    const issues = buildTodayOperationsScheduleConsistencySnapshot({
      businessDate: '2026-08-23',
      scheduleRecords: [
        {
          ...scheduleRecord,
          fields: {
            ...scheduleRecord.fields,
            '请假人员（请假表）': '',
            '替班人员（请假表）': '',
          },
        },
      ],
      overtimeRecords: [
        {
          record_id: 'rec_overtime_ordinary',
          fields: {
            加班人员姓名: '周庆庆',
            加班开始时间: Date.parse('2026-08-22T18:00:00+08:00'),
            加班结束时间: Date.parse('2026-08-23T09:00:00+08:00'),
            加班原因: '机房专项工作',
            机楼: 'A楼',
            加班工作流状态: '已审批',
          },
        },
      ],
      leaveApproval: { verified: true, requests: [] },
    });

    expect(issues).toEqual([]);
  });

  it('checks today plus only a previous night shift still running at 08:30', () => {
    const previousWhite = {
      ...scheduleRecord,
      record_id: 'rec_110_white_20260829',
      fields: {
        ...scheduleRecord.fields,
        排班日期: '2026-08-29',
        机楼: '110站',
        班次: '白班',
      },
    };
    const previous110Night = {
      ...scheduleRecord,
      record_id: 'rec_110_night_20260829',
      fields: {
        ...scheduleRecord.fields,
        排班日期: '2026-08-29',
        机楼: '110站',
        班次: '夜班',
      },
    };
    const previousANight = {
      ...scheduleRecord,
      record_id: 'rec_a_night_20260829',
      fields: {
        ...scheduleRecord.fields,
        排班日期: '2026-08-29',
        机楼: 'A楼',
        班次: '夜班',
      },
    };
    const todayWhite = {
      ...scheduleRecord,
      record_id: 'rec_110_white_20260830',
      fields: {
        ...scheduleRecord.fields,
        排班日期: '2026-08-30',
        机楼: '110站',
        班次: '白班',
      },
    };
    const records = [
      previousWhite,
      previous110Night,
      previousANight,
      todayWhite,
    ];
    const requests = records.map((record) => ({
      ...leaveApproval.requests[0],
      recordId: `leave_${record.record_id}`,
      impactedScheduleRecordIds: [record.record_id],
      substituteStaff: ['周庆庆'],
    }));

    const issues = buildTodayOperationsScheduleConsistencySnapshot({
      businessDate: '2026-08-30',
      scheduleRecords: records,
      overtimeRecords: [],
      leaveApproval: { verified: true, requests },
    });
    const scheduleIds = new Set(issues.map((issue) => issue.scheduleRecordId));

    expect(scheduleIds).toEqual(
      new Set(['rec_a_night_20260829', 'rec_110_white_20260830']),
    );
  });

  it('waits ten minutes after approval before reporting a missing schedule sync', () => {
    const currentSchedule = {
      ...scheduleRecord,
      record_id: 'rec_a_white_20260830',
      fields: {
        ...scheduleRecord.fields,
        排班日期: '2026-08-30',
        班次: '白班',
        '值班人员（实际）程序修改': '李董',
      },
    };
    const approval: LeaveApprovalSnapshot = {
      verified: true,
      requests: [
        {
          ...leaveApproval.requests[0],
          recordId: 'rec_leave_recent',
          leaveStaff: ['王五'],
          impactedScheduleRecordIds: ['rec_a_white_20260830'],
          approvedAt: '2026-08-30T01:01:00.000Z',
        },
      ],
    };
    const build = (detectedAt: string) =>
      buildTodayOperationsScheduleConsistencySnapshot({
        businessDate: '2026-08-30',
        detectedAt,
        syncGraceMs: 10 * 60_000,
        scheduleRecords: [currentSchedule],
        leaveApproval: approval,
      });

    expect(build('2026-08-30T01:05:00.000Z')).toEqual([]);
    expect(build('2026-08-30T01:12:00.000Z')).toEqual([
      expect.objectContaining({ kind: 'approved_substitute_missing' }),
    ]);
  });
});
