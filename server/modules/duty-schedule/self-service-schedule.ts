import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { MonthlySchedule } from '../../../shared/api.interface';
import { containsExactPersonName } from '../../../shared/leave-request-impact';
import { isStation110DutyApplicant } from '../../../shared/workforce-request-applicant';
import type { SelfServiceScheduleResponse } from '../../../shared/self-service-schedule.interface';
import type { ConfigurationDirectorySnapshot } from '../../common/access/access-configuration.directory';
import { matchesSelfServicePersonnelIdentity } from '../../common/access/self-service-applicant';

const identityProblems = new Set([
  '人员记录身份缺失或重复',
  '人员姓名未维护',
  '人员飞书身份关联不一致',
  '在职人员飞书身份重复',
]);
const normalizedName = (name: string) => name.replace(/\s+/g, '');

export function selfServiceScheduleMonth(
  yearInput: string,
  monthInput: string,
) {
  if (
    !/^20\d{2}$/.test(yearInput) ||
    !/^(?:0?[1-9]|1[0-2])$/.test(monthInput)
  ) {
    throw new BadRequestException('排班月份无效');
  }
  const year = Number(yearInput),
    month = Number(monthInput),
    prefix = `${year}-${String(month).padStart(2, '0')}`;
  return {
    year,
    month,
    startDate: `${prefix}-01`,
    endDate: `${prefix}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`,
  };
}

export function resolveSelfServiceScheduleApplicant(
  principal: AccessPrincipal,
  directory: ConfigurationDirectorySnapshot,
  now = Date.now(),
): string {
  if (
    !/^(?:feishu-|local-external-)[a-f0-9]{64}$/.test(
      principal.accountId || '',
    ) ||
    !principal.displayName?.trim() ||
    isStation110DutyApplicant(principal)
  ) {
    throw new ForbiddenException('请使用已绑定本人人员资料的个人账号读取班次');
  }
  const authority = directory.personnelAuthority;
  if (
    !directory.personnelComplete ||
    directory.activeMembersComplete !== true ||
    !directory.employmentState?.complete ||
    !authority ||
    !authority.source.appId ||
    authority.source.appId !== directory.appId ||
    !authority.source.appToken ||
    !authority.source.tableId ||
    !Number.isFinite(directory.snapshotAt) ||
    directory.snapshotAt < now - 5 * 60_000 ||
    directory.snapshotAt > now + 5_000 ||
    !Number.isFinite(authority.snapshotAt) ||
    authority.snapshotAt < now - 5 * 60_000 ||
    authority.snapshotAt > now + 5_000 ||
    authority.problems.some((problem) => identityProblems.has(problem)) ||
    authority.people.some((person) => !person.recordId || !person.name?.trim())
  ) {
    throw new ServiceUnavailableException(
      '人员身份来源不完整或已过期，暂时无法读取本人班次',
    );
  }
  const matches = authority.people.filter((person) =>
    matchesSelfServicePersonnelIdentity(principal, {
      ...authority.source,
      recordId: person.recordId,
      openId: person.openId,
    }),
  );
  if (
    matches.length !== 1 ||
    !matches[0].active ||
    matches[0].type === 'duty_account' ||
    matches[0].name.trim() !== principal.displayName.trim()
  ) {
    throw new ForbiddenException(
      '登录账号未唯一匹配到在职本人，请联系管理员核对',
    );
  }
  const name = matches[0].name.trim();
  // The schedule source stores names. Stable identity must resolve first, and
  // name collisions across the complete source cannot be disambiguated here.
  if (
    authority.people.filter(
      (person) => normalizedName(person.name) === normalizedName(name),
    ).length !== 1
  ) {
    throw new ForbiddenException(
      '人员来源存在同名记录，暂时无法安全区分本人班次',
    );
  }
  return name;
}

export function projectSelfServiceSchedules(
  schedules: readonly MonthlySchedule[],
  applicantName: string,
  range: { startDate: string; endDate: string },
): SelfServiceScheduleResponse {
  if (
    !Array.isArray(schedules) ||
    schedules.some(
      (row) =>
        !row ||
        !row.recordId ||
        !Array.isArray(row.dutyStaffActual) ||
        row.dutyStaffActual.some((name) => typeof name !== 'string'),
    )
  ) {
    throw new ServiceUnavailableException(
      '排班来源不完整，暂时无法读取本人班次',
    );
  }
  const ownNames = (names: readonly string[] | undefined) =>
    names?.some((name) => containsExactPersonName(name, applicantName))
      ? [applicantName]
      : [];
  return {
    scope: 'self',
    applicantName,
    range,
    complete: true,
    schedules: schedules
      .filter(
        (row) =>
          row.scheduleDate &&
          row.scheduleDate >= range.startDate &&
          row.scheduleDate <= range.endDate &&
          row.dutyStaffActual.some((name) =>
            containsExactPersonName(name, applicantName),
          ),
      )
      .map((row) => ({
        id: row.id,
        recordId: row.recordId,
        scheduleDate: row.scheduleDate,
        building: row.building,
        buildingText: row.buildingText,
        team: row.team,
        teamText: row.teamText,
        shift: row.shift,
        shiftText: row.shiftText,
        dutyCode: null,
        code: null,
        personText: containsExactPersonName(row.personText || '', applicantName)
          ? applicantName
          : '',
        dutyStaffReference: ownNames(row.dutyStaffReference),
        dutyStaffActual: [applicantName],
        actualDutyStaff: applicantName,
        leaveStaff: ownNames(row.leaveStaff),
        substituteStaff: ownNames(row.substituteStaff),
        travelStaff: ownNames(row.travelStaff),
        remark: '',
        emergencyDuty: '',
        emergencyDutySchedule: '',
        createdAt: '',
        updatedAt: '',
      })),
  };
}
