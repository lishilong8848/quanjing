import {
  LeaveApprovalRoutingError,
  buildLeaveShiftCandidateSets,
  buildLeaveApprovalPlan,
  requiresLongWhiteSubstituteDecision,
  requiresSupervisorSubstitute,
  validateLeaveShiftAssignmentPlan,
} from './leave-workflow.rules';
import type {
  LeaveApprovalRoutingInput,
  LeaveOrganizationRecord,
  LeaveSubstituteCandidate,
} from './leave-workflow.types';
import type {
  LeaveRequestImpactSchedule,
  LeaveRequestShiftGroup,
} from '../../../shared/leave-request-impact';

const people = {
  applicant: person('张三', 'ou_applicant', '运维值班员', ['A楼'], ['施小东']),
  buildingLead: person('施小东', 'ou_building_lead', '设施运维主管', ['A楼']),
  manager: person(
    '马进宇',
    'ou_manager',
    '设施运维经理',
    ['全园区'],
    ['马进宇'],
  ),
  deputy: person(
    '梅冰冰',
    'ou_deputy',
    '设施运维副经理',
    ['全园区'],
    ['梅冰冰'],
  ),
  dutyAccount: person(
    'A楼值班账号',
    'ou_duty_a',
    '值班账号',
    ['A楼'],
    ['施小东'],
  ),
  hApplicant: person(
    '李四',
    'ou_h_applicant',
    '运维值班员',
    ['H楼'],
    ['周庆庆'],
  ),
  hLead: person('周庆庆', 'ou_h_lead', 'H楼值班主管', ['H楼']),
  hDutyAccount: person(
    'H楼值班账号',
    'ou_duty_h',
    '值班账号',
    ['H楼'],
    ['周庆庆'],
  ),
  stationApplicant: person(
    '王五',
    'ou_110_applicant',
    '运维值班员',
    ['110站'],
    ['赵六'],
  ),
  electricalLead: person('赵六', 'ou_electrical_lead', '电气主管', ['110站']),
  electricalEngineer: person(
    '钱七',
    'ou_electrical_engineer',
    '电气工程师',
    ['A楼'],
    ['施小东'],
  ),
  fireEngineer: person('孙八', 'ou_fire_engineer', '消防工程师', ['A楼']),
  fireLead: person('吴九', 'ou_fire_lead', '消防主管', ['全园区']),
};

const directory: LeaveOrganizationRecord[] = [
  people.applicant,
  people.hApplicant,
  people.stationApplicant,
  people.electricalEngineer,
  people.buildingLead,
  people.manager,
  people.deputy,
  people.dutyAccount,
  people.hLead,
  people.hDutyAccount,
  people.electricalLead,
  people.fireLead,
];

describe('buildLeaveApprovalPlan', () => {
  it('routes an ordinary A-building leave shorter than 3 days to the building supervisor only', () => {
    const plan = buildLeaveApprovalPlan(input({ approvalDayCount: 2.99 }));

    expect(plan.stages).toEqual([
      expect.objectContaining({
        key: 'supervisor',
        approvers: [
          expect.objectContaining({ openId: people.buildingLead.openId }),
        ],
      }),
    ]);
    expect(
      plan.notificationPlan.finalResultRecipients.map(
        (person) => person.openId,
      ),
    ).toEqual(
      expect.arrayContaining([
        people.applicant.openId,
        people.buildingLead.openId,
        people.manager.openId,
        people.deputy.openId,
      ]),
    );
  });

  it('requires a manager stage when approvalDayCount is exactly 3', () => {
    const plan = buildLeaveApprovalPlan(input({ approvalDayCount: 3 }));

    expect(plan.stages.map((stage) => stage.key)).toEqual([
      'supervisor',
      'manager',
    ]);
    expect(plan.stages[1].approvers.map((person) => person.openId)).toEqual([
      people.manager.openId,
      people.deputy.openId,
    ]);
  });

  it('uses the H duty supervisor and the 110 electrical supervisor for their respective ordinary applicants', () => {
    const hPlan = buildLeaveApprovalPlan(
      input({ applicant: people.hApplicant }),
    );
    const stationPlan = buildLeaveApprovalPlan(
      input({ applicant: people.stationApplicant }),
    );

    expect(hPlan.stages[0].approvers.map((person) => person.openId)).toEqual([
      people.hLead.openId,
    ]);
    expect(
      stationPlan.stages[0].approvers.map((person) => person.openId),
    ).toEqual([people.electricalLead.openId]);
  });

  it('routes a 110 station chief by the same configured supervisor rule as other 110 staff', () => {
    const stationChief = person(
      '张华',
      'ou_station_chief',
      '110站站长',
      ['110站'],
      ['周海祥'],
    );
    const stationSupervisor = person(
      '周海祥',
      'ou_station_supervisor',
      '电气主管',
      ['H楼'],
    );
    const plan = buildLeaveApprovalPlan(
      input({
        applicant: stationChief,
        organizationRecords: [
          stationChief,
          stationSupervisor,
          people.manager,
          people.deputy,
        ],
      }),
    );

    expect(plan.stages).toEqual([
      expect.objectContaining({
        key: 'supervisor',
        approvers: [
          expect.objectContaining({ openId: stationSupervisor.openId }),
        ],
      }),
    ]);
    expect(
      plan.stages[0].approvers.map((person) => person.openId),
    ).not.toContain(people.manager.openId);
  });

  it('fails closed when the configured station-chief supervisor has no Feishu Open ID', () => {
    const stationChief = person(
      '张华',
      'ou_station_chief',
      '110站站长',
      ['110站'],
      ['周海祥'],
    );

    expect(() =>
      buildLeaveApprovalPlan(
        input({
          applicant: stationChief,
          organizationRecords: [
            stationChief,
            person('周海祥', '', '电气主管', ['H楼']),
            people.manager,
          ],
        }),
      ),
    ).toThrow(
      new LeaveApprovalRoutingError(
        'APPROVER_NOT_FOUND',
        '审批人“周海祥”在组织架构中不存在或缺少飞书账号',
      ),
    );
  });

  it('fails closed when the configured station-chief supervisor name has multiple Open IDs', () => {
    const stationChief = person(
      '张华',
      'ou_station_chief',
      '110站站长',
      ['110站'],
      ['周海祥'],
    );

    expect(() =>
      buildLeaveApprovalPlan(
        input({
          applicant: stationChief,
          organizationRecords: [
            stationChief,
            person('周海祥', 'ou_station_supervisor_1', '电气主管', ['H楼']),
            person('周海祥', 'ou_station_supervisor_2', '电气主管', ['110站']),
            people.manager,
          ],
        }),
      ),
    ).toThrow(
      new LeaveApprovalRoutingError(
        'APPROVER_NAME_NOT_UNIQUE',
        '审批人“周海祥”在组织架构中存在多个飞书账号，无法唯一解析',
      ),
    );
  });

  it('uses the sole valid supervisor account when an earlier same-name record has no account', () => {
    const stationChief = person(
      '张华',
      'ou_station_chief',
      '110站站长',
      ['110站'],
      ['周海祥'],
    );
    const plan = buildLeaveApprovalPlan(
      input({
        applicant: stationChief,
        organizationRecords: [
          stationChief,
          person('周海祥', '', '电气主管', ['110站']),
          person('周海祥', 'ou_station_supervisor', '电气主管', ['H楼']),
          people.manager,
        ],
      }),
    );

    expect(plan.stages[0].approvers.map((person) => person.openId)).toEqual([
      'ou_station_supervisor',
    ]);
  });

  it('keeps the configured supervisor route for ordinary 110 station staff', () => {
    const ordinarySupervisor = person(
      '普通值班主管',
      'ou_ordinary_110_supervisor',
      '110值班主管',
      ['110站'],
    );
    const ordinaryApplicant = person(
      '普通值班员',
      'ou_ordinary_110_staff',
      '110值班人员',
      ['110站'],
      [ordinarySupervisor.name],
    );
    const stationElectricalSupervisor = person(
      '周海祥',
      'ou_station_supervisor',
      '电气主管',
      ['110站'],
    );
    const plan = buildLeaveApprovalPlan(
      input({
        applicant: ordinaryApplicant,
        organizationRecords: [
          ordinaryApplicant,
          ordinarySupervisor,
          stationElectricalSupervisor,
          people.manager,
        ],
      }),
    );

    expect(plan.stages[0].approvers.map((person) => person.openId)).toEqual([
      ordinarySupervisor.openId,
    ]);
  });

  it('routes a 110 applicant without a Feishu account by personnel record identity', () => {
    const applicant = {
      ...person('卞天洋', '', '110值班人员', ['110站'], ['赵六']),
      personRecordId: 'rec_110_bian',
    };
    const plan = buildLeaveApprovalPlan(
      input({
        applicant,
        organizationRecords: [
          applicant,
          people.electricalLead,
          people.manager,
          people.deputy,
        ],
      }),
    );

    expect(plan.stages[0].approvers.map((person) => person.openId)).toEqual([
      people.electricalLead.openId,
    ]);
    expect(
      plan.notificationPlan.finalResultRecipients.map(
        (person) => person.openId,
      ),
    ).not.toContain('');
  });

  it('always uses the applicant supervisor field instead of the legacy duty-account supervisor', () => {
    const plan = buildLeaveApprovalPlan(
      input({
        organizationRecords: directory.map((record) =>
          record.openId === people.dutyAccount.openId
            ? { ...record, supervisorNames: ['周庆庆'] }
            : record,
        ),
      }),
    );

    expect(plan.stages[0].approvers.map((person) => person.openId)).toEqual([
      people.buildingLead.openId,
    ]);
  });

  it('routes a building supervisor directly to managers and sends professional notice separately', () => {
    const managerPlan = buildLeaveApprovalPlan(
      input({ applicant: people.buildingLead, approvalDayCount: 1 }),
    );
    const electricalPlan = buildLeaveApprovalPlan(
      input({ applicant: people.electricalEngineer, approvalDayCount: 1 }),
    );
    const firePlan = buildLeaveApprovalPlan(
      input({ applicant: people.fireEngineer, approvalDayCount: 1 }),
    );

    expect(managerPlan.stages.map((stage) => stage.key)).toEqual(['manager']);
    expect(
      electricalPlan.notificationPlan.professionalRecipients.map(
        (person) => person.openId,
      ),
    ).toEqual([people.electricalLead.openId]);
    expect(firePlan.stages.map((stage) => stage.key)).toEqual(['manager']);
    expect(
      firePlan.notificationPlan.professionalRecipients.map(
        (person) => person.openId,
      ),
    ).toEqual([people.fireLead.openId]);
  });

  it('fails closed when a manager applicant has no configured non-self escalation approver', () => {
    expect(() =>
      buildLeaveApprovalPlan({
        applicant: people.manager,
        organizationRecords: [people.manager],
        approvalDayCount: 1,
      }),
    ).toThrow(
      new LeaveApprovalRoutingError(
        'MANAGER_ESCALATION_NOT_CONFIGURED',
        '经理或副经理请休假未配置非本人上级审批组，已拒绝自动路由',
      ),
    );
  });
});

describe('requiresSupervisorSubstitute', () => {
  it.each([
    [person('甲', 'ou_h_duty', '运维值班员', ['H楼']), true],
    [person('乙', 'ou_h_lead', '运维值班长', ['H楼']), true],
    [person('周庆庆', 'ou_h_supervisor', 'H楼值班主管', ['H楼']), true],
    [person('丙', 'ou_h_foc', 'FOC', ['H楼']), false],
    [person('丁', 'ou_d_any', '实习生（备岗）', ['D楼']), true],
    [person('戊', 'ou_e_any', '设施工程师', ['E楼']), true],
    [person('己', 'ou_a_duty', '运维值班员', ['A楼']), true],
    [person('庚', 'ou_b_duty', '运维值班长', ['B楼']), true],
    [person('辛', 'ou_c_duty', '值班员', ['C楼']), true],
    [person('壬', 'ou_a_long_day', '运维工程师', ['A楼']), false],
    [person('癸', 'ou_110_duty', '运维值班员', ['110站']), true],
    [person('子', 'ou_110_support', '实习生（备岗）', ['110站']), true],
  ])('%s', (applicant, expected) => {
    expect(requiresSupervisorSubstitute(applicant)).toBe(expected);
  });
});

describe('leave shift substitute assignments', () => {
  const groups: LeaveRequestShiftGroup[] = [
    {
      shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
      scheduleDate: '2026-08-26',
      startAt: '2026-08-26T09:00',
      endAt: '2026-08-26T18:00',
      kind: 'white',
      shift: '白班',
      buildings: ['A楼'],
      teams: ['一班'],
      scheduleRecordIds: ['schedule-1'],
      leaveHours: 8,
    },
    {
      shiftKey: '2026-08-27T18:00__2026-08-28T09:00',
      scheduleDate: '2026-08-27',
      startAt: '2026-08-27T18:00',
      endAt: '2026-08-28T09:00',
      kind: 'night',
      shift: '夜班',
      buildings: ['B楼'],
      teams: ['二班'],
      scheduleRecordIds: ['schedule-2'],
      leaveHours: 15,
    },
  ];
  const candidates: LeaveSubstituteCandidate[] = [
    {
      personRecordId: 'rec_zhang',
      name: '张三',
      openId: 'ou_zhang',
      position: '运维值班员',
      buildings: ['A楼'],
    },
    {
      personRecordId: 'rec_li',
      name: '李四',
      openId: 'ou_li',
      position: '运维值班员',
      buildings: ['B楼'],
    },
  ];

  it('computes eligible candidates independently for each shift', () => {
    const schedules: LeaveRequestImpactSchedule[] = [
      {
        recordId: 'schedule-1',
        scheduleDate: '2026-08-26',
        building: 'A楼',
        team: '一班',
        shift: '白班',
        dutyStaffActual: ['曹雷'],
      },
      {
        recordId: 'zhang-conflict',
        scheduleDate: '2026-08-26',
        building: 'C楼',
        team: '三班',
        shift: '白班',
        dutyStaffActual: ['张三'],
      },
      {
        recordId: 'schedule-2',
        scheduleDate: '2026-08-27',
        building: 'B楼',
        team: '二班',
        shift: '夜班',
        dutyStaffActual: ['曹雷'],
      },
      {
        recordId: 'li-conflict',
        scheduleDate: '2026-08-27',
        building: 'D楼',
        team: '四班',
        shift: '夜班',
        dutyStaffActual: ['李四'],
      },
    ];

    expect(
      buildLeaveShiftCandidateSets({
        groups,
        schedules,
        applicant: {
          personRecordId: 'rec_cao',
          name: '曹雷',
          openId: 'ou_cao',
          position: '运维值班员',
          buildings: ['A楼'],
        },
        selectablePeople: candidates,
      }).map((set) => ({
        shiftKey: set.shiftKey,
        candidateIds: set.candidates.map(
          (candidate) => candidate.personRecordId,
        ),
      })),
    ).toEqual([
      { shiftKey: groups[0].shiftKey, candidateIds: ['rec_li'] },
      { shiftKey: groups[1].shiftKey, candidateIds: ['rec_zhang'] },
    ]);
  });

  it('resolves a complete assignment plan atomically', () => {
    expect(
      validateLeaveShiftAssignmentPlan({
        groups,
        selections: [
          {
            shiftKey: groups[0].shiftKey,
            substitutePersonRecordId: 'rec_zhang',
          },
          { shiftKey: groups[1].shiftKey, substitutePersonRecordId: 'rec_li' },
        ],
        candidateSets: groups.map((group) => ({
          shiftKey: group.shiftKey,
          candidates,
        })),
        actorOpenId: 'ou_supervisor',
        actorName: '主管',
        changedAt: '2026-08-25T10:00:00.000Z',
      }),
    ).toMatchObject({
      valid: true,
      assignments: [
        { shiftKey: groups[0].shiftKey, substitutePersonRecordId: 'rec_zhang' },
        { shiftKey: groups[1].shiftKey, substitutePersonRecordId: 'rec_li' },
      ],
    });
  });

  it('allows one person on non-overlapping shifts and rejects overlap or missing selections', () => {
    const candidateSets = groups.map((group) => ({
      shiftKey: group.shiftKey,
      candidates,
    }));
    const baseInput = {
      groups,
      candidateSets,
      actorOpenId: 'ou_supervisor',
      actorName: '主管',
      changedAt: '2026-08-25T10:00:00.000Z',
    };

    expect(
      validateLeaveShiftAssignmentPlan({
        ...baseInput,
        selections: groups.map((group) => ({
          shiftKey: group.shiftKey,
          substitutePersonRecordId: 'rec_zhang',
        })),
      }),
    ).toMatchObject({ valid: true });

    const overlappingGroups = [
      groups[0],
      {
        ...groups[1],
        shiftKey: '2026-08-26T18:00__2026-08-27T09:00',
        scheduleDate: '2026-08-26',
        startAt: '2026-08-26T18:00',
        endAt: '2026-08-27T09:00',
      },
    ];
    expect(
      validateLeaveShiftAssignmentPlan({
        ...baseInput,
        groups: overlappingGroups,
        candidateSets: overlappingGroups.map((group) => ({
          shiftKey: group.shiftKey,
          candidates,
        })),
        selections: overlappingGroups.map((group) => ({
          shiftKey: group.shiftKey,
          substitutePersonRecordId: 'rec_zhang',
        })),
      }),
    ).toMatchObject({ valid: false, shiftKey: overlappingGroups[1].shiftKey });

    expect(
      validateLeaveShiftAssignmentPlan({
        ...baseInput,
        selections: [
          {
            shiftKey: groups[0].shiftKey,
            substitutePersonRecordId: 'rec_zhang',
          },
        ],
      }),
    ).toMatchObject({ valid: false, shiftKey: groups[1].shiftKey });
  });
});

describe('requiresLongWhiteSubstituteDecision', () => {
  const longWhiteGroup: LeaveRequestShiftGroup = {
    shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
    scheduleDate: '2026-08-26',
    startAt: '2026-08-26T09:00',
    endAt: '2026-08-26T18:00',
    kind: 'long_white',
    shift: '长白',
    buildings: ['E楼'],
    teams: ['长白'],
    scheduleRecordIds: ['rec_long_white_1'],
    leaveHours: 8,
  };

  it('requires a supervisor choice only when every affected shift is long-white', () => {
    expect(requiresLongWhiteSubstituteDecision([longWhiteGroup])).toBe(true);
    expect(
      requiresLongWhiteSubstituteDecision([
        longWhiteGroup,
        { ...longWhiteGroup, kind: 'night', shift: '夜班' },
      ]),
    ).toBe(false);
    expect(requiresLongWhiteSubstituteDecision([])).toBe(false);
  });
});

function input(
  overrides: Partial<LeaveApprovalRoutingInput> = {},
): LeaveApprovalRoutingInput {
  return {
    applicant: people.applicant,
    organizationRecords: directory,
    approvalDayCount: 1,
    ...overrides,
  };
}

function person(
  name: string,
  openId: string,
  position: string,
  buildings: string[],
  supervisorNames: string[] = [],
): LeaveOrganizationRecord {
  return { name, openId, position, buildings, supervisorNames };
}
