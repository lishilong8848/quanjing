import {
  excludesApprovedLeave,
  excludesInactiveSubstitute,
} from '../../server/modules/duty-schedule/attendance-approved-leave';
import { buildDailyAttendanceExpectationPlan } from '../../server/modules/duty-schedule/attendance-automation.expectations';
import type { ApprovedLeaveRequest } from '../../server/common/feishu/leave-approval-source';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ModuleKind, transpileModule } from 'typescript';

const request: ApprovedLeaveRequest = {
  recordId: 'leave-test',
  leaveStaff: ['施小东'],
  substituteStaff: [],
  startAt: '2026-09-07T09:00:00+08:00',
  endAt: '2026-09-07T18:00:00+08:00',
  building: 'building_a',
  team: '',
  shift: '',
  impactedScheduleRecordIds: [],
};
const event = {
  name: '施小东',
  building: 'A楼',
  expectedAt: '2026-09-07 09:00:00',
  direction: 'OnDuty' as const,
};
it('restores the uncovered half-day punch before precise leave filtering and limits the substitute to the covered boundary', () => {
  const halfDay = {
    ...request,
    startAt: '2026-09-07T13:00:00+08:00',
    substituteStaff: ['测试替班'],
  };
  const plan = buildDailyAttendanceExpectationPlan({
    date: '2026-09-07',
    preciseLeave: true,
    schedules: [
      {
        recordId: 'schedule',
        scheduleDate: '2026-09-07',
        building: 'building_a',
        shift: 'white',
        team: 'team_a',
        dutyStaffReference: ['施小东'],
        dutyStaffActual: ['测试替班'],
        leaveStaff: ['施小东'],
        substituteStaff: ['测试替班'],
      },
    ] as never,
    longWhiteBuildings: [],
  });
  const included = plan.expectations.filter(
    (item) =>
      !excludesApprovedLeave(item, [halfDay]) &&
      !excludesInactiveSubstitute(item, [halfDay]),
  );
  expect(included.map((item) => [item.name, item.direction])).toEqual([
    ['施小东', 'OnDuty'],
    ['测试替班', 'OffDuty'],
  ]);
});
it('excludes approved leave even when the archived punch is still missing', () => {
  expect(excludesApprovedLeave(event, [request])).toBe(true);
  expect(
    excludesApprovedLeave(
      { ...event, expectedAt: '2026-09-07 18:00:00', direction: 'OffDuty' },
      [request],
    ),
  ).toBe(true);
});
it('applies the approved leave attendance exemption to business travel', () => {
  const travelRequest = {
    ...request,
    leaveType: '差旅',
  } as ApprovedLeaveRequest & { leaveType: '差旅' };
  expect(excludesApprovedLeave(event, [travelRequest])).toBe(true);
});
it('does not exclude another day, building or uncovered half-day punch', () => {
  expect(
    excludesApprovedLeave({ ...event, expectedAt: '2026-09-08 09:00:00' }, [
      request,
    ]),
  ).toBe(false);
  expect(excludesApprovedLeave({ ...event, building: 'B楼' }, [request])).toBe(
    false,
  );
  expect(
    excludesApprovedLeave(event, [
      { ...request, startAt: '2026-09-07T13:00:00+08:00' },
    ]),
  ).toBe(false);
});
it('treats adjacent shift boundaries by direction and handles overnight leave', () => {
  const overnight = {
    ...request,
    startAt: '2026-09-07T18:00:00+08:00',
    endAt: '2026-09-08T09:00:00+08:00',
  };
  expect(
    excludesApprovedLeave(
      { ...event, expectedAt: '2026-09-08 09:00:00', direction: 'OffDuty' },
      [overnight],
    ),
  ).toBe(true);
  expect(
    excludesApprovedLeave({ ...event, expectedAt: '2026-09-08 09:00:00' }, [
      overnight,
    ]),
  ).toBe(false);
});

it.each(['王甲', '陈乙', '刘丙', '周丁'])(
  'applies the same leave rule to any staff member: %s',
  (name) => {
    const approved = {
      ...request,
      leaveStaff: [name],
      substituteStaff: ['替班人员'],
    };
    expect(excludesApprovedLeave({ ...event, name }, [approved])).toBe(true);
    expect(
      excludesApprovedLeave({ ...event, name: '替班人员' }, [approved]),
    ).toBe(false);
    expect(
      excludesApprovedLeave({ ...event, name, building: 'B楼' }, [approved]),
    ).toBe(false);
  },
);

it('interprets timezone-less approval times as Shanghai even on a UTC host', () => {
  const source = readFileSync(
    resolve(
      __dirname,
      '../../server/modules/duty-schedule/attendance-approved-leave.ts',
    ),
    'utf8',
  );
  const implementation = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const approval = {
    ...request,
    startAt: '2026-09-07T09:00',
    endAt: '2026-09-07T18:00',
  };
  const script = `${implementation}\nprocess.stdout.write(JSON.stringify(exports.excludesApprovedLeave(${JSON.stringify(event)}, [${JSON.stringify(approval)}])));`;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' },
    timeout: 5000,
    windowsHide: true,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('true');
});

it('ignores an approved leave with invalid dates without blocking the attendance batch', () => {
  expect(excludesApprovedLeave(event, [{ ...request, endAt: null }])).toBe(
    false,
  );
});
