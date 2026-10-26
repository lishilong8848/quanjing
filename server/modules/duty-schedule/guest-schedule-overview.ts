import type { MonthlySchedule } from '../../../shared/api.interface';

export function toGuestScheduleOverview(schedules: readonly MonthlySchedule[]): MonthlySchedule[] {
  return schedules.filter(item => !/long[_ -]?white|长白/i.test(`${item.shift} ${item.shiftText}`)).map(item => ({
    id: item.id, recordId: item.recordId, dutyCode: item.dutyCode, scheduleDate: item.scheduleDate,
    code: item.code, building: item.building, team: item.team, shift: item.shift,
    personText: item.personText, dutyStaffReference: [...item.dutyStaffReference], dutyStaffActual: [...item.dutyStaffActual],
    remark: '', emergencyDuty: item.emergencyDuty, emergencyDutySchedule: item.emergencyDutySchedule,
    leaveStaff: [...item.leaveStaff], substituteStaff: [...item.substituteStaff],
    ...(item.leaveAssignments ? { leaveAssignments: item.leaveAssignments.map(assignment => ({
      requestRecordId: '', leaveStaffName: assignment.leaveStaffName, substituteStaff: [...assignment.substituteStaff],
      startAt: assignment.startAt, endAt: assignment.endAt, leaveHours: assignment.leaveHours,
    })) } : {}),
    ...(item.travelStaff ? { travelStaff: [...item.travelStaff] } : {}),
    actualDutyStaff: item.actualDutyStaff, buildingText: item.buildingText, teamText: item.teamText, shiftText: item.shiftText,
    createdAt: '', updatedAt: '',
  }));
}
