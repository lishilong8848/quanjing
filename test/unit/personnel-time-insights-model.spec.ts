import { buildPersonnelTimeInsights } from '../../server/modules/personnel-time-insights/personnel-time-insights.model';
import type { LeaveWorkflowApplicationEntry } from '../../server/modules/leave-workflow/leave-workflow.store';
import type {
  OvertimeWorkflowApplicationEntry,
  OvertimeWorkflowConfirmationEntry,
} from '../../server/modules/overtime-workflow/overtime-workflow.store';

function overtimeApplication(
  recordId: string,
  overrides: Partial<OvertimeWorkflowApplicationEntry> = {},
): OvertimeWorkflowApplicationEntry {
  return {
    recordId,
    phase: 'confirmed',
    snapshot: {
      recordId,
      applicantName: '示例人员008',
      applicantOpenId: 'ou_zhangsan',
      building: 'H楼',
      position: '运维值班员',
      plannedStartAt: '2026-02-01 18:00',
      plannedEndAt: '2026-02-02 09:00',
      plannedHours: 15,
      reason: '测试',
    },
    ...overrides,
  } as OvertimeWorkflowApplicationEntry;
}

function confirmation(
  recordId: string,
  actualHours: number,
  disposition: '调休' | '加班费' | '费用结算' | null,
  actualStartAt = '2026-02-01 18:00',
): OvertimeWorkflowConfirmationEntry {
  return {
    recordId,
    draft: { actualStartAt, actualHours, disposition },
  } as OvertimeWorkflowConfirmationEntry;
}

function leaveApplication(
  recordId: string,
  overrides: Partial<LeaveWorkflowApplicationEntry> = {},
): LeaveWorkflowApplicationEntry {
  return {
    recordId,
    status: 'approved',
    snapshot: {
      applicantName: '示例人员008',
      applicantOpenId: 'ou_zhangsan',
      applicantPersonRecordId: 'rec_person_zhangsan',
      applicantNotificationOpenIds: ['ou_zhangsan'],
      building: 'H楼',
      position: '运维值班员',
      leaveType: '年假',
      startAt: '2026-02-10 09:00',
      endAt: '2026-02-10 18:00',
      leaveHours: 8,
      approvalDayCount: 1,
      reason: '测试',
      shiftGroups: [
        {
          shiftKey: '2026-02-10',
          scheduleDate: '2026-02-10',
          startAt: '2026-02-10 09:00',
          endAt: '2026-02-10 18:00',
          kind: 'long_white',
          shift: '长白',
          buildings: ['H楼'],
          teams: [],
          scheduleRecordIds: ['rec_schedule_1'],
          leaveHours: 8,
        },
      ],
    },
    ...overrides,
  } as LeaveWorkflowApplicationEntry;
}

describe('personnel time insights model', () => {
  it('列出待确认申请时段但不计为实际加班', () => {
    const result = buildPersonnelTimeInsights({
      from: '2026-02-01',
      through: '2026-02-28',
      overtimeApplications: [
        overtimeApplication('pending', { phase: 'awaiting_confirmation' }),
      ],
      overtimeConfirmations: [],
      leaveApplications: [],
    });
    expect(result.people[0].details).toMatchObject({
      pendingOvertime: [
        {
          recordId: 'pending',
          startAt: '2026-02-01 18:00',
          endAt: '2026-02-02 09:00',
          hours: 15,
        },
      ],
    });
    expect(result.metrics.overtimeHours).toBe(0);
  });

  it('保留确认的实际结束时间并推导历史结束时间', () => {
    const explicit = confirmation('explicit', 3, '加班费');
    explicit.draft.actualEndAt = '2026-02-01 21:00';
    const result = buildPersonnelTimeInsights({
      from: '2026-02-01',
      through: '2026-02-28',
      overtimeApplications: [
        overtimeApplication('explicit'),
        overtimeApplication('legacy'),
      ],
      overtimeConfirmations: [explicit, confirmation('legacy', 15, '调休')],
      leaveApplications: [],
    });
    expect(result.people[0].details.overtime).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: 'explicit',
          endAt: '2026-02-01 21:00',
        }),
        expect.objectContaining({
          recordId: 'legacy',
          endAt: '2026-02-02 09:00',
        }),
      ]),
    );
  });

  it('按确认处置和已审批休假计算人员及楼栋汇总', () => {
    const overtimeApplications = [
      overtimeApplication('ot_comp'),
      overtimeApplication('ot_pay'),
      overtimeApplication('ot_legacy'),
      overtimeApplication('ot_pending', { phase: 'awaiting_confirmation' }),
      overtimeApplication('ot_rejected', { phase: 'rejected' }),
    ];
    const overtimeConfirmations = [
      confirmation('ot_comp', 15, '调休'),
      confirmation('ot_pay', 8, '加班费', '2026-03-01 09:00'),
      confirmation('ot_legacy', 4, null, '2026-03-02 18:00'),
    ];
    const leaveApplications = [
      leaveApplication('leave_annual'),
      leaveApplication('leave_comp', {
        snapshot: {
          ...leaveApplication('leave_template').snapshot,
          leaveType: '调休',
          startAt: '2026-03-10 09:00',
          endAt: '2026-03-10 18:00',
          shiftGroups: [
            {
              ...leaveApplication('leave_template').snapshot.shiftGroups![0],
              shiftKey: '2026-03-10',
              scheduleDate: '2026-03-10',
              startAt: '2026-03-10 09:00',
              endAt: '2026-03-10 18:00',
            },
          ],
        },
      }),
      leaveApplication('leave_travel', {
        snapshot: {
          ...leaveApplication('leave_template').snapshot,
          leaveType: '差旅',
          startAt: '2026-04-01 09:00',
          endAt: '2026-04-01 18:00',
          shiftGroups: [
            {
              ...leaveApplication('leave_template').snapshot.shiftGroups![0],
              shiftKey: '2026-04-01',
              scheduleDate: '2026-04-01',
              startAt: '2026-04-01 09:00',
              endAt: '2026-04-01 18:00',
            },
          ],
        },
      }),
      leaveApplication('leave_rejected', { status: 'rejected' }),
    ];

    const result = buildPersonnelTimeInsights({
      from: '2026-01-01',
      through: '2026-12-31',
      overtimeApplications,
      overtimeConfirmations,
      leaveApplications,
    });

    expect(result.metrics).toMatchObject({
      overtimePeople: 1,
      overtimeHours: 27,
      overtimePayHours: 8,
      compensatoryAccruedHours: 19,
      compensatoryUsedHours: 8,
      compensatoryAvailableHours: 11,
      leaveHours: 16,
      travelHours: 8,
    });
    expect(result.pendingOvertime).toEqual({ count: 1, people: ['示例人员008'] });
    expect(result.quality.legacyDefaultedCompensatoryCount).toBe(1);
    expect(result.people[0]).toMatchObject({
      name: '示例人员008',
      building: 'H楼',
      overtimeHours: 27,
      overtimePayHours: 8,
      compensatoryAccruedHours: 19,
      compensatoryUsedHours: 8,
      compensatoryAvailableHours: 11,
      leaveHours: 16,
      travelHours: 8,
      pendingOvertimeCount: 1,
    });
    expect(result.buildings[0]).toMatchObject({
      building: 'H楼',
      peopleCount: 1,
      overtimeHours: 27,
      leaveHours: 16,
      travelHours: 8,
    });
    expect(
      result.monthly.find((item) => item.month === '2026-02'),
    ).toMatchObject({ overtimeHours: 15, leaveHours: 8 });
    expect(
      result.monthly.find((item) => item.month === '2026-03'),
    ).toMatchObject({
      overtimeHours: 12,
      leaveHours: 8,
      compensatoryUsedHours: 8,
    });
    expect(
      result.monthly.find((item) => item.month === '2026-04'),
    ).toMatchObject({ travelHours: 8 });
  });

  it('保留负调休余额，并按班次日期精确截取跨周期请休假', () => {
    const template = leaveApplication('leave_cross').snapshot;
    const result = buildPersonnelTimeInsights({
      from: '2026-03-01',
      through: '2026-03-31',
      overtimeApplications: [overtimeApplication('ot_comp')],
      overtimeConfirmations: [confirmation('ot_comp', 4, '调休')],
      leaveApplications: [
        leaveApplication('leave_cross', {
          snapshot: {
            ...template,
            leaveType: '调休',
            startAt: '2026-02-28 09:00',
            endAt: '2026-03-02 18:00',
            leaveHours: 24,
            shiftGroups: [
              {
                ...template.shiftGroups![0],
                shiftKey: '2026-02-28',
                scheduleDate: '2026-02-28',
                startAt: '2026-02-28 09:00',
                endAt: '2026-02-28 18:00',
              },
              {
                ...template.shiftGroups![0],
                shiftKey: '2026-03-01',
                scheduleDate: '2026-03-01',
                startAt: '2026-03-01 09:00',
                endAt: '2026-03-01 18:00',
              },
              {
                ...template.shiftGroups![0],
                shiftKey: '2026-03-02',
                scheduleDate: '2026-03-02',
                startAt: '2026-03-02 09:00',
                endAt: '2026-03-02 18:00',
              },
            ],
          },
        }),
      ],
    });

    expect(result.metrics.compensatoryAccruedHours).toBe(0);
    expect(result.metrics.compensatoryUsedHours).toBe(16);
    expect(result.metrics.compensatoryAvailableHours).toBe(-16);
    expect(result.people[0].compensatoryAvailableHours).toBe(-16);
    expect(result.people[0].details.leave).toHaveLength(2);
  });

  it('无正式记录时返回稳定的零统计', () => {
    const result = buildPersonnelTimeInsights({
      from: '2026-01-01',
      through: '2026-12-31',
      overtimeApplications: [],
      overtimeConfirmations: [],
      leaveApplications: [],
    });

    expect(result.metrics.overtimeHours).toBe(0);
    expect(result.metrics.compensatoryAvailableHours).toBe(0);
    expect(result.people).toEqual([]);
    expect(result.buildings).toEqual([]);
    expect(result.monthly).toHaveLength(12);
  });
});
