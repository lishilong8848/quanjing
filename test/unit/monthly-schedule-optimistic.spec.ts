import {
  applyOptimisticLeave,
  applyOptimisticLeaveToRecords,
  appendOptimisticDutyStaff,
  removeOptimisticDutyStaff,
  replaceScheduleMonthsFromAuthoritative,
  replaceOptimisticDutyStaff,
  restoreOptimisticSchedules,
} from '../../client/src/pages/MonthlySchedule/optimistic-schedule';
import { readFileSync } from 'fs';
import { join } from 'path';

const schedules = [
  {
    recordId: 'rec1',
    scheduleDate: '2026-07-21',
    building: 'building_a',
    team: 'shift_a',
    shift: 'white',
    dutyStaffActual: ['张三', '李四'],
    leaveStaff: [],
    substituteStaff: [],
  },
  {
    recordId: 'rec2',
    scheduleDate: '2026-07-22',
    building: 'building_b',
    team: 'shift_b',
    shift: 'night',
    dutyStaffActual: ['王五'],
    leaveStaff: [],
    substituteStaff: [],
  },
];

describe('monthly schedule optimistic updates', () => {
  it('appends vacancy substitutes without duplicates', () => {
    const result = appendOptimisticDutyStaff(schedules, [
      { recordId: 'rec1', staffName: '赵六' },
      { recordId: 'rec1', staffName: '赵六' },
    ]);
    expect(result[0].dutyStaffActual).toEqual(['张三', '李四', '赵六']);
  });

  it('replaces a duty staff member immediately', () => {
    const result = replaceOptimisticDutyStaff(
      schedules,
      'rec1',
      '李四',
      '赵六',
    );
    expect(result[0].dutyStaffActual).toEqual(['张三', '赵六']);
  });

  it('removes travel or movement staff in the selected range', () => {
    const result = removeOptimisticDutyStaff(schedules, '张三', {
      startDate: '2026-07-21',
      endDate: '2026-07-22',
    });
    expect(result[0].dutyStaffActual).toEqual(['李四']);
    expect(result[1].dutyStaffActual).toEqual(['王五']);
  });

  it('applies leave and substitute fields immediately', () => {
    const result = applyOptimisticLeave(schedules, {
      staffName: '张三',
      substituteName: '赵六',
      startDate: '2026-07-21',
      endDate: '2026-07-21',
      building: 'building_a',
      team: 'shift_a',
      shift: 'white',
    });
    expect(result[0]).toMatchObject({
      dutyStaffActual: ['赵六', '李四'],
      leaveStaff: ['张三'],
      substituteStaff: ['赵六'],
    });
    expect(result[1]).toBe(schedules[1]);
  });

  it('matches display aliases with the internal schedule scope', () => {
    const result = applyOptimisticLeave(schedules, {
      staffName: schedules[0].dutyStaffActual[0],
      substituteName: 'replacement',
      startDate: '2026-07-21',
      building: 'A\u697c',
      team: 'A\u73ed',
      shift: '\u767d\u73ed',
    });

    expect(result[0].dutyStaffActual).toEqual([
      'replacement',
      schedules[0].dutyStaffActual[1],
    ]);
  });

  it('applies leave only to the exact affected schedule records', () => {
    const result = applyOptimisticLeaveToRecords(schedules, {
      staffName: '张三',
      substituteName: '赵六',
      recordIds: ['rec1'],
    });

    expect(result[0]).toMatchObject({
      dutyStaffActual: ['张三', '李四'],
      leaveStaff: ['张三'],
      substituteStaff: ['赵六'],
    });
    expect(result[1]).toBe(schedules[1]);
  });

  it.each([
    '周庆庆 施海伟',
    '周庆庆、施海伟',
    '周庆庆,施海伟',
    '周庆庆/施海伟',
  ])(
    'marks an exact person inside a multi-person duty cell: %s',
    (dutyStaffCell) => {
      const multiPersonSchedule = {
        ...schedules[0],
        dutyStaffActual: [dutyStaffCell],
      };

      const [result] = applyOptimisticLeaveToRecords([multiPersonSchedule], {
        staffName: '周庆庆',
        substituteName: '施海伟',
        recordIds: [multiPersonSchedule.recordId],
      });

      expect(result).toMatchObject({
        dutyStaffActual: [dutyStaffCell],
        leaveStaff: ['周庆庆'],
        substituteStaff: ['施海伟'],
      });
    },
  );

  it('does not treat a name prefix in a multi-person cell as an exact match', () => {
    const multiPersonSchedule = {
      ...schedules[0],
      dutyStaffActual: ['周庆庆一 施海伟'],
    };

    const [result] = applyOptimisticLeaveToRecords([multiPersonSchedule], {
      staffName: '周庆庆',
      recordIds: [multiPersonSchedule.recordId],
    });

    expect(result).toBe(multiPersonSchedule);
  });

  it('replaces refreshed months, removes deleted records, and preserves pending records', () => {
    const current = [
      ...schedules,
      {
        ...schedules[0],
        recordId: 'rec-deleted',
        dutyStaffActual: ['已删除排班'],
      },
      {
        ...schedules[0],
        recordId: 'rec-pending',
        dutyStaffActual: ['本地同步中'],
      },
    ];
    const incoming = [
      {
        ...schedules[0],
        dutyStaffActual: ['飞书最新值'],
      },
      {
        ...schedules[0],
        recordId: 'rec-pending',
        dutyStaffActual: ['飞书旧值'],
      },
    ];

    const result = replaceScheduleMonthsFromAuthoritative(
      current,
      incoming,
      ['2026-07-01'],
      ['rec-pending'],
    );

    expect(result.map((item) => item.recordId)).toEqual([
      'rec1',
      'rec-pending',
    ]);
    expect(result[0].dutyStaffActual).toEqual(['飞书最新值']);
    expect(result[1].dutyStaffActual).toEqual(['本地同步中']);
  });

  it('restores only snapshotted records after a failed request', () => {
    const optimistic = appendOptimisticDutyStaff(schedules, [
      { recordId: 'rec1', staffName: '赵六' },
    ]);
    const unrelated = optimistic.map((item) =>
      item.recordId === 'rec2'
        ? { ...item, dutyStaffActual: ['新并发值'] }
        : item,
    );
    const restored = restoreOptimisticSchedules(unrelated, [schedules[0]]);
    expect(restored[0]).toBe(schedules[0]);
    expect(restored[1].dutyStaffActual).toEqual(['新并发值']);
  });

  it('updates every page mutation state before awaiting the backend', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const handler = (startName: string, endName: string) => {
      const start = source.indexOf(`const ${startName}`);
      const end = source.indexOf(`const ${endName}`, start + 1);
      return source.slice(start, end < 0 ? source.length : end);
    };
    const expectations = [
      [
        'handleSubmitVacancySubstitutes',
        'handleSubmitStaffRepair',
        'setVacancyDialogOpen(false)',
        'await updateVacancySubstitutes',
      ],
      [
        'handleSubmitStaffRepair',
        'handleSubmitTravelStaff',
        'replaceOptimisticDutyStaff',
        'await updateDutyStaffAdjustment',
      ],
      [
        'handleSubmitTravelStaff',
        'handleSubmitPersonnelMovement',
        'removeOptimisticDutyStaff',
        'await updateTravelStaff',
      ],
      [
        'handleSubmitPersonnelMovement',
        'startTravelDetailEdit',
        'setPersonnelMovementDialogOpen(false)',
        'await createPersonnelMovement',
      ],
      [
        'handleSubmitTravelAdjustment',
        'handleRevokeTravelDetail',
        'setTravelDetails',
        'await adjustTravelStaff',
      ],
      [
        'confirmRevokeTravelDetail',
        'handleSubmitLeaveRequest',
        'setTravelDetails',
        'await revokeTravelStaff',
      ],
      [
        'handleSubmitAdditionalMatter',
        'handleAddSealingRegistrationRow',
        'setAdditionalMatterDialogOpen(false)',
        'await createAdditionalMatter',
      ],
      [
        'handleSubmitSealingRegistration',
        'upsertExceptionFollowUpItem',
        'setSealings',
        'await Promise.all',
      ],
      [
        'handleSubmitExceptionFollowUp',
        'handleDeleteExceptionFollowUpItem',
        'upsertExceptionFollowUpItem(optimisticItem)',
        'await updateExceptionFollowUp',
      ],
      [
        'handleDeleteExceptionFollowUpItem',
        'handleDeleteExceptionFollowUp',
        'removeExceptionFollowUpItem(item)',
        'await deleteExceptionFollowUp',
      ],
      [
        'handleSubmitChangeAdjustment',
        'handleClearChangeAdjustment',
        'setChanges',
        'await updateChangeScheduleAdjustment',
      ],
    ];

    expectations.forEach(
      ([startName, endName, optimisticText, requestText]) => {
        const block = handler(startName, endName);
        expect(block.indexOf(optimisticText)).toBeGreaterThanOrEqual(0);
        expect(block.indexOf(optimisticText)).toBeLessThan(
          block.indexOf(requestText),
        );
      },
    );
    expect(source).toContain('restoreOptimisticSchedules');
    expect(source.match(/\.rollback\(\)/g)?.length || 0).toBeGreaterThanOrEqual(
      6,
    );
    const leaveHandler = handler(
      'handleSubmitLeaveRequest',
      'handleSubmitChangeRequest',
    );
    expect(leaveHandler).toContain('leaveRequestSubmittingRef.current');
    expect(leaveHandler).toContain('clientMutationId');
    expect(leaveHandler).toContain('expectedImpact: leaveImpact');
    expect(leaveHandler).toContain('isBackendStatus(error, 409)');
    expect(leaveHandler).toContain('ensureSchedulesForLeaveDateRange');
    expect(leaveHandler.indexOf('await createLeaveRequest')).toBeLessThan(
      leaveHandler.indexOf('await ensureSchedulesForLeaveDateRange'),
    );
    expect(leaveHandler).toContain('void coordinateLeaveRequestSubmit');
    expect(leaveHandler).not.toContain('applyOptimisticLeaveToRecords');
    expect(leaveHandler).not.toContain('optimisticMutation.reconcile');
    expect(leaveHandler).not.toContain('syncDutyScheduleToLocalFast()');
    expect(leaveHandler).not.toContain('monthlyScheduleCache.clear()');
    expect(leaveHandler).not.toContain('loadSchedules()');
    expect(leaveHandler).toContain(
      'leaveRequestMutationBindingRef.current = null',
    );
    expect(leaveHandler).toContain(
      'if (staleImpactConflict && leaveScheduleCoverageKey)',
    );
  });
});
