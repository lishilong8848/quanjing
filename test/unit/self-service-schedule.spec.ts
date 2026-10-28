import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { MonthlySchedule } from '../../shared/api.interface';
import { canPerformBusinessAction } from '../../shared/business-permissions';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { SelfServiceScheduleController } from '../../server/modules/duty-schedule/self-service-schedule.controller';
import {
  projectSelfServiceSchedules,
  resolveSelfServiceScheduleApplicant,
  selfServiceScheduleMonth,
} from '../../server/modules/duty-schedule/self-service-schedule';

const source = {
  appId: 'synthetic-self-app',
  appToken: 'synthetic-base',
  tableId: 'tblSynthetic',
};
const name = '合成本人',
  openId = 'ou_synthetic_self',
  recordId = 'recSyntheticSelf';
const ownId = `feishu-${feishuIdentityFingerprint(source.appId, openId)}`;
function actor(
  module: 'leave_requests' | 'overtime_requests' = 'leave_requests',
): AccessPrincipal {
  return {
    role: 'guest',
    accountId: ownId,
    authorizationVersion: 1,
    purchaseBuilding: null,
    displayName: name,
    effectiveAuthorization: {
      mode: 'independent',
      baseline: {
        nativeRole: null,
        pages: [],
        rules: [
          {
            id: 'synthetic-create',
            module,
            actions: ['create'],
            effect: 'allow',
            buildings: null,
            specialties: null,
          },
        ],
      },
      overrides: { rules: [], allowPages: [], denyPages: [] },
    },
  };
}
function directory(): ConfigurationDirectorySnapshot {
  const now = Date.now();
  return {
    appId: source.appId,
    people: [],
    employees: [],
    snapshotAt: now,
    personnelComplete: true,
    activeMembersComplete: true,
    employmentState: { complete: true, entries: [] },
    personnelAuthority: {
      mode: 'shadow',
      source,
      version: 'synthetic-version',
      snapshotAt: now,
      problems: [],
      issues: [],
      duties: [],
      people: [
        {
          id: 'synthetic-person-id',
          recordId,
          openId,
          name,
          active: true,
          type: 'employee',
          position: '工程师',
          systemPosition: '',
          buildings: ['A楼'],
          specialties: ['电气'],
          permissionTags: [],
          dutyRecordIds: [],
        },
      ],
    },
  };
}
function schedule(overrides: Partial<MonthlySchedule> = {}): MonthlySchedule {
  return {
    id: 'synthetic-schedule',
    recordId: 'recSyntheticSchedule',
    dutyCode: 'PRIVATE_CODE',
    scheduleDate: '2026-10-04',
    code: 10,
    building: 'building_a',
    buildingText: 'A楼',
    team: 'shift_a',
    teamText: 'A班',
    shift: 'white',
    shiftText: '白班',
    dutyStaffActual: [name, 'OTHER_PRIVATE_PERSON'],
    dutyStaffReference: [name, 'OTHER_PRIVATE_PERSON'],
    personText: `${name}、OTHER_PRIVATE_PERSON`,
    actualDutyStaff: `${name}、OTHER_PRIVATE_PERSON`,
    leaveStaff: ['OTHER_PRIVATE_PERSON'],
    substituteStaff: [name, 'OTHER_PRIVATE_PERSON'],
    travelStaff: ['OTHER_PRIVATE_PERSON'],
    leaveAssignments: [
      {
        requestRecordId: 'PRIVATE_LEAVE',
        leaveStaffName: 'OTHER_PRIVATE_PERSON',
        substituteStaff: [name],
        startAt: null,
        endAt: null,
        leaveHours: 8,
      },
    ],
    remark: 'OTHER_PRIVATE_REMARK',
    emergencyDuty: 'OTHER_PRIVATE_DUTY',
    emergencyDutySchedule: 'OTHER_PRIVATE_SCHEDULE',
    createdAt: 'PRIVATE_DATE',
    updatedAt: 'PRIVATE_DATE',
    ...overrides,
  };
}
const range = { startDate: '2026-10-01', endDate: '2026-10-31' };

describe('self-service schedule identity is resolved before matching schedule names', () => {
  it('accepts the unique stable Feishu identity', () => {
    expect(resolveSelfServiceScheduleApplicant(actor(), directory())).toBe(
      name,
    );
  });
  it('accepts only the exact source-bound local personnel identity', () => {
    const person = actor();
    person.accountId = `local-external-${createHash('sha256')
      .update(
        JSON.stringify([
          source.appId,
          source.appToken,
          source.tableId,
          recordId,
        ]),
      )
      .digest('hex')}`;
    expect(resolveSelfServiceScheduleApplicant(person, directory())).toBe(name);
    const changed = directory();
    changed.personnelAuthority!.source = { ...source, tableId: 'tblOther' };
    expect(() => resolveSelfServiceScheduleApplicant(person, changed)).toThrow(
      '未唯一匹配',
    );
  });
  it('does not resolve by a supplied display name when the stable identity differs', () => {
    expect(() =>
      resolveSelfServiceScheduleApplicant(
        { ...actor(), accountId: `feishu-${'0'.repeat(64)}` },
        directory(),
      ),
    ).toThrow('未唯一匹配');
    expect(() =>
      resolveSelfServiceScheduleApplicant(
        { ...actor(), displayName: '另一人' },
        directory(),
      ),
    ).toThrow('未唯一匹配');
  });
  it('rejects normalized same-name rows even when their identities differ', () => {
    const snapshot = directory();
    snapshot.personnelAuthority!.people.push({
      ...snapshot.personnelAuthority!.people[0],
      id: 'other',
      recordId: 'recOther',
      openId: 'ou_other',
      name: '合成 本人',
    });
    expect(() =>
      resolveSelfServiceScheduleApplicant(actor(), snapshot),
    ).toThrow('同名');
  });
  it('rejects duplicated stable identities, inactive people and shared duty accounts', () => {
    const snapshot = directory();
    snapshot.personnelAuthority!.people.push({
      ...snapshot.personnelAuthority!.people[0],
      recordId: 'recOther',
    });
    expect(() =>
      resolveSelfServiceScheduleApplicant(actor(), snapshot),
    ).toThrow('未唯一匹配');
    const inactive = directory();
    inactive.personnelAuthority!.people[0].active = false;
    expect(() =>
      resolveSelfServiceScheduleApplicant(actor(), inactive),
    ).toThrow('在职本人');
    const shared = directory();
    shared.personnelAuthority!.people[0].type = 'duty_account';
    expect(() => resolveSelfServiceScheduleApplicant(actor(), shared)).toThrow(
      '在职本人',
    );
  });
  it.each([
    'personnel',
    'members',
    'employment',
    'stale',
    'missing-name',
  ] as const)('fails closed for incomplete %s source', (kind) => {
    const snapshot = directory();
    if (kind === 'personnel') snapshot.personnelComplete = false;
    if (kind === 'members') snapshot.activeMembersComplete = false;
    if (kind === 'employment') snapshot.employmentState!.complete = false;
    if (kind === 'stale') snapshot.snapshotAt -= 6 * 60_000;
    if (kind === 'missing-name')
      snapshot.personnelAuthority!.problems = ['人员姓名未维护'];
    expect(() =>
      resolveSelfServiceScheduleApplicant(actor(), snapshot),
    ).toThrow(ServiceUnavailableException);
  });
});

describe('self-service schedule response has an explicit privacy whitelist', () => {
  it('never treats a name prefix as the authenticated person', () => {
    expect(
      projectSelfServiceSchedules(
        [schedule({ dutyStaffActual: [`${name}二`] })],
        name,
        range,
      ).schedules,
    ).toEqual([]);
  });
  it('keeps only the person and necessary shift fields without changing the shared source', () => {
    const input = [
      schedule(),
      schedule({
        id: 'another',
        recordId: 'recAnother',
        dutyStaffActual: ['OTHER_PRIVATE_PERSON'],
      }),
      schedule({ recordId: 'recOtherMonth', scheduleDate: '2026-11-01' }),
    ];
    const original = structuredClone(input);
    const result = projectSelfServiceSchedules(input, name, range);
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]).toMatchObject({
      dutyStaffActual: [name],
      dutyStaffReference: [name],
      substituteStaff: [name],
      leaveStaff: [],
      travelStaff: [],
      personText: name,
      actualDutyStaff: name,
      remark: '',
      dutyCode: null,
    });
    expect(result.schedules[0]).not.toHaveProperty('leaveAssignments');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(input).toEqual(original);
  });
  it('does not treat valid rest periods or weekdays-only source as incomplete', () => {
    expect(projectSelfServiceSchedules([], name, range)).toEqual({
      scope: 'self',
      applicantName: name,
      range,
      complete: true,
      schedules: [],
    });
    expect(
      projectSelfServiceSchedules([schedule()], name, range).schedules,
    ).toHaveLength(1);
  });
  it('rejects malformed source instead of presenting it as an empty month', () => {
    expect(() =>
      projectSelfServiceSchedules(
        [schedule({ dutyStaffActual: null as never })],
        name,
        range,
      ),
    ).toThrow(ServiceUnavailableException);
  });
  it.each([
    ['2026x', '10'],
    ['2026', '13'],
    ['2026', '0'],
  ])('rejects invalid month %s/%s', (year, month) => {
    expect(() => selfServiceScheduleMonth(year, month)).toThrow('排班月份无效');
  });
});

describe('self-service schedule endpoint does not require or grant whole-schedule read', () => {
  function controller() {
    const people = { read: jest.fn(async () => directory()) };
    const schedules = {
      getMonthlySchedules: jest.fn(async () => [schedule()]),
    };
    return {
      endpoint: new SelfServiceScheduleController(
        people as never,
        schedules as never,
      ),
      people,
      schedules,
    };
  }
  it.each(['leave_requests', 'overtime_requests'] as const)(
    'allows %s create-only and reads the existing source without force',
    async (module) => {
      const { endpoint, schedules } = controller(),
        principal = actor(module);
      expect(
        canPerformBusinessAction(principal, {
          module: 'monthly_schedule',
          action: 'read',
        }),
      ).toBe(false);
      const response = await endpoint.read('2026', '10', {
        accessPrincipal: principal,
        accessPrincipalFingerprint: 'synthetic-session',
      });
      expect(response.applicantName).toBe(name);
      expect(response.scope).toBe('self');
      expect(schedules.getMonthlySchedules).toHaveBeenCalledWith(
        2026,
        10,
        false,
      );
    },
  );
  it('rejects missing session or action permission before source reads', async () => {
    const { endpoint, people, schedules } = controller();
    await expect(
      endpoint.read('2026', '10', { accessPrincipal: actor() }),
    ).rejects.toThrow('请先登录');
    const principal = actor();
    principal.effectiveAuthorization!.baseline.rules = [];
    await expect(
      endpoint.read('2026', '10', {
        accessPrincipal: principal,
        accessPrincipalFingerprint: 'session',
      }),
    ).rejects.toThrow('没有请休假或加班');
    expect(people.read).not.toHaveBeenCalled();
    expect(schedules.getMonthlySchedules).not.toHaveBeenCalled();
  });
  it.each([{ name: '另一人' }, { refresh: 'true' }, { force: '1' }])(
    'rejects selectors/force parameters: %j',
    async (query) => {
      const { endpoint, people } = controller();
      await expect(
        endpoint.read(
          '2026',
          '10',
          { accessPrincipal: actor(), accessPrincipalFingerprint: 'session' },
          query,
        ),
      ).rejects.toThrow('不接受');
      expect(people.read).not.toHaveBeenCalled();
    },
  );
  it('does not read schedules for a mismatched identity or convert an unavailable schedule into success', async () => {
    const { endpoint, schedules } = controller();
    await expect(
      endpoint.read('2026', '10', {
        accessPrincipal: { ...actor(), accountId: `feishu-${'0'.repeat(64)}` },
        accessPrincipalFingerprint: 'session',
      }),
    ).rejects.toThrow('未唯一匹配');
    expect(schedules.getMonthlySchedules).not.toHaveBeenCalled();
    schedules.getMonthlySchedules.mockRejectedValueOnce(
      new ServiceUnavailableException('缺少完整快照'),
    );
    await expect(
      endpoint.read('2026', '10', {
        accessPrincipal: actor(),
        accessPrincipalFingerprint: 'session',
      }),
    ).rejects.toThrow('缺少完整快照');
  });
});
