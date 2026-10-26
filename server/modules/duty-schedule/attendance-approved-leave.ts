import type { ApprovedLeaveRequest } from '@server/common/feishu/leave-approval-source';
import type { AttendanceExpectation } from './attendance-automation.rules';

export function excludesInactiveSubstitute(
  event: AttendanceExpectation,
  requests: readonly ApprovedLeaveRequest[],
): boolean {
  if (event.status !== 'substitute') return false;
  const assignments = requests.filter(
    (request) =>
      building(request.building) === building(event.building) &&
      [
        ...request.substituteStaff,
        ...(request.shiftDetails || []).flatMap(
          (detail) => detail.substituteStaff,
        ),
      ].some((name) => normalize(name) === normalize(event.name)),
  );
  if (!assignments.length) return false;
  return !assignments.some((request) =>
    excludesApprovedLeave(event, [{ ...request, leaveStaff: [event.name] }]),
  );
}

export function excludesApprovedLeave(
  event: Pick<
    AttendanceExpectation,
    'name' | 'building' | 'expectedAt' | 'direction'
  >,
  requests: readonly ApprovedLeaveRequest[],
): boolean {
  const time = parseShanghaiTime(event.expectedAt);
  if (!Number.isFinite(time)) return false;
  return requests.some((request) => {
    if (
      !request.leaveStaff.some(
        (name) => normalize(name) === normalize(event.name),
      )
    )
      return false;
    if (
      request.building &&
      building(request.building) !== building(event.building)
    )
      return false;
    if (!hasValidApprovedLeavePeriod(request)) return false;
    const start = parseShanghaiTime(request.startAt);
    const end = parseShanghaiTime(request.endAt);
    // Leave ending at 09:00 excuses the previous night OffDuty, not today's OnDuty.
    return event.direction === 'OnDuty'
      ? start <= time && time < end
      : start < time && time <= end;
  });
}

export function hasValidApprovedLeavePeriod(
  request: Pick<ApprovedLeaveRequest, 'startAt' | 'endAt'>,
): boolean {
  const start = parseShanghaiTime(request.startAt);
  const end = parseShanghaiTime(request.endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

function parseShanghaiTime(value: string | null): number {
  const text = value?.trim().replace(' ', 'T');
  if (!text) return Number.NaN;
  return Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : `${text}+08:00`,
  );
}

function normalize(value: string): string {
  return value.replace(/\s+/g, '').trim();
}
function building(value: string): string {
  return normalize(value)
    .toLowerCase()
    .replace(/^building_/, '')
    .replace(/[楼栋]/g, '')
    .replace('station_', '')
    .replace('站', '');
}
