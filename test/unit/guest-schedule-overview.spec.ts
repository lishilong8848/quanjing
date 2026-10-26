import { canReadPage } from '../../shared/page-access';
import { toGuestScheduleOverview } from '../../server/modules/duty-schedule/guest-schedule-overview';
import type { MonthlySchedule } from '../../shared/api.interface';
import { DutyScheduleController } from '../../server/modules/duty-schedule/duty-schedule.controller';
describe('guest scheduling overview', () => {
  it('opens only the schedule landing overview, keeping other restricted pages closed', () => {
    expect(canReadPage('guest', '/monthly-schedule')).toBe(true);
    for (const path of ['/today-operations-panorama','/operations-kb','/monthly-operations','/construction-management']) expect(canReadPage('guest', path)).toBe(false);
    expect(canReadPage('guest', '/monthly-schedule/apply/leave')).toBe(false);
    expect(canReadPage('guest', '/monthly-schedule/detail', ['/monthly-schedule'])).toBe(false);
  });
  it('keeps names and leave/substitute summaries while excluding long-white and maintenance fields', () => {
    const item = { id:'qa', recordId:'recQa', dutyCode:null, scheduleDate:'2026-10-11', code:1, building:'A', team:'甲', shift:'white', personText:'验收甲', dutyStaffReference:['验收甲'], dutyStaffActual:['验收乙'], remark:'private-note', emergencyDuty:'应急验收', emergencyDutySchedule:'', leaveStaff:['验收甲'], substituteStaff:['验收乙'], actualDutyStaff:'验收乙', buildingText:'A楼', teamText:'甲', shiftText:'白', createdAt:'private-date', updatedAt:'private-date', privateField:'never-return', leaveAssignments:[{ requestRecordId:'private-request', leaveStaffName:'验收甲', substituteStaff:['验收乙'], startAt:'2026-10-11T08:00:00', endAt:'2026-10-11T16:00:00', leaveHours:8 }] } as MonthlySchedule;
    const result = toGuestScheduleOverview([item, { ...item, shift:'long_white' }, { ...item, shiftText:'长白班' }]);
    expect(result).toHaveLength(1);
    expect(result[0].dutyStaffActual).toEqual(['验收乙']);
    expect(result[0].leaveAssignments?.[0].leaveHours).toBe(8);
    expect(JSON.stringify(result)).not.toMatch(/private-|never-return/);
    expect(item.remark).toBe('private-note');
    result[0].dutyStaffActual.push('新项');
    expect(item.dutyStaffActual).toEqual(['验收乙']);
  });
  it('uses guest projection in the actual monthly handler and keeps authenticated output unchanged', async () => {
    const schedules = [{ shift:'long_white', shiftText:'长白班' }] as MonthlySchedule[];
    const service = { getMonthlySchedules: jest.fn().mockResolvedValue(schedules) };
    const controller = Object.assign(Object.create(DutyScheduleController.prototype), { dutyScheduleService: service }) as DutyScheduleController;
    expect(await controller.getMonthlySchedules('2026', '10', undefined, { accessRole:'guest' } as never)).toEqual({ schedules:[] });
    expect((await controller.getMonthlySchedules('2026', '10', undefined, { accessRole:'editor' } as never)).schedules).toBe(schedules);
    expect(service.getMonthlySchedules).toHaveBeenCalledWith(2026, 10, false);
  });
});
