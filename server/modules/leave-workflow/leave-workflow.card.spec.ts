import {
  buildLeaveApprovalCard,
  buildLeaveRejectionPromptCard,
  buildLeaveSubstituteAdjustmentCard,
  buildLeaveSubstituteAdjustmentTerminalCard,
  buildLeaveSubstituteChangeNotificationCard,
  buildLeaveTerminalCard,
} from './leave-workflow.card';

describe('leave workflow cards', () => {
  const context = {
    recordId: 'rec_leave_1',
    applicationKey: 'leave:rec_leave_1',
    stageKey: 'supervisor' as const,
    stageVersion: 1,
    applicantName: '示例人员008',
    building: 'A楼',
    position: '运维值班员',
    leaveType: '年假',
    startAt: '2026-08-17T09:00:00+08:00',
    endAt: '2026-08-17T18:00:00+08:00',
    leaveHours: 8,
    approvalDayCount: 1,
    reason: '家庭事务',
  };

  it('creates a compact approval card with strictly typed leave callback values', () => {
    const card = buildLeaveApprovalCard(context);
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('请休假申请 · 待示例人员001审批');
    expect(serialized).not.toContain('wide_screen_mode');
    expect(card).toEqual(
      expect.objectContaining({
        schema: '2.0',
        body: expect.objectContaining({
          padding: '12px 12px 12px 12px',
          vertical_spacing: '8px',
        }),
      }),
    );
    expect(serialized).toContain('申请概览');
    expect(serialized).toContain('2026-08-17 09:00 至 2026-08-17 18:00');
    expect(serialized).toContain('workflowType');
    expect(serialized).toContain('"leave"');
    expect(serialized).toContain('"stageVersion":1');
    expect(serialized).toContain('同意');
    expect(serialized).toContain('驳回');
    expect(serialized).not.toContain('leave_rejection_reason');
    expect(serialized).toContain('open_rejection');
  });

  it('uses travel wording and neutral field labels for a travel application', () => {
    const serialized = JSON.stringify(
      buildLeaveApprovalCard({ ...context, leaveType: '差旅' }),
    );

    expect(serialized).toContain('差旅申请 · 待示例人员001审批');
    expect(serialized).toContain('**申请概览**');
    expect(serialized).toContain('类型');
    expect(serialized).toContain('原因');
    expect(serialized).not.toContain('休假类型');
    expect(serialized).not.toContain('请假原因');
  });

  it('places the leave screenshot evidence between the summary and approval controls', () => {
    const card = buildLeaveApprovalCard({
      ...context,
      screenshotImageKeys: ['img_v3_leave_evidence_1'],
      screenshotStatus: 'ready',
    });
    const elements = (card.body as { elements: Array<Record<string, unknown>> })
      .elements;
    const imageIndex = elements.findIndex((element) => element.tag === 'img');
    const approvalIndex = elements.findIndex((element) =>
      JSON.stringify(element).includes('"action":"approve"'),
    );

    expect(elements[imageIndex]).toEqual({
      tag: 'img',
      img_key: 'img_v3_leave_evidence_1',
      alt: { tag: 'plain_text', content: '请休假流程截图' },
    });
    expect(imageIndex).toBeGreaterThan(0);
    expect(approvalIndex).toBeGreaterThan(imageIndex);
    expect(JSON.stringify(elements.slice(0, imageIndex))).toContain('流程截图');
  });

  it('keeps approval available when the screenshot cannot be previewed', () => {
    const serialized = JSON.stringify(
      buildLeaveApprovalCard({
        ...context,
        screenshotImageKeys: [],
        screenshotStatus: 'unavailable',
      }),
    );

    expect(serialized).toContain('截图暂不可预览');
    expect(serialized).not.toContain('"tag":"img"');
    expect(serialized).toContain('"action":"approve"');
  });

  it('omits input properties rejected by the Feishu card schema', () => {
    const card = buildLeaveApprovalCard(context);

    expect(JSON.stringify(card)).not.toContain('"min_length"');
  });

  it('requires an eligible personnel selection only on a substitute-required supervisor card', () => {
    const card = buildLeaveApprovalCard({
      ...context,
      substituteRequired: true,
      substituteCandidates: [
        {
          personRecordId: 'rec_substitute',
          name: '示例人员013',
          openId: '',
          position: '实习生（备岗）',
          buildings: ['D楼'],
        },
      ],
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('select_static');
    expect(serialized).toContain('leave_substitute_person_record_id');
    expect(serialized).toContain('rec_substitute');
    expect(serialized).toContain('示例人员013');
    expect(serialized).toContain('form_action_type');
    expect(serialized).toContain(
      'leave_approve_submit:rec_leave_1:supervisor:1',
    );
    expect(serialized).not.toContain('ou_substitute');
    expect(serialized).not.toContain('"selected"');
  });

  it('renders one required substitute selector for every actual shift', () => {
    const shiftGroups = [
      {
        shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
        scheduleDate: '2026-08-26',
        startAt: '2026-08-26T09:00',
        endAt: '2026-08-26T18:00',
        kind: 'white' as const,
        shift: '白班',
        buildings: ['A楼'],
        teams: ['一班'],
        scheduleRecordIds: ['schedule_1'],
        leaveHours: 8,
      },
      {
        shiftKey: '2026-08-27T18:00__2026-08-28T09:00',
        scheduleDate: '2026-08-27',
        startAt: '2026-08-27T18:00',
        endAt: '2026-08-28T09:00',
        kind: 'night' as const,
        shift: '夜班',
        buildings: ['B楼'],
        teams: ['二班'],
        scheduleRecordIds: ['schedule_2'],
        leaveHours: 15,
      },
    ];
    const card = buildLeaveApprovalCard({
      ...context,
      applicantName: '示例人员012',
      substituteRequired: true,
      shiftGroups,
      candidateSets: [
        {
          shiftKey: shiftGroups[0].shiftKey,
          candidates: [
            {
              personRecordId: 'rec_zhang',
              name: '示例人员008',
              openId: 'ou_zhang',
              position: '运维值班员',
              buildings: ['A楼'],
            },
          ],
        },
        {
          shiftKey: shiftGroups[1].shiftKey,
          candidates: [
            {
              personRecordId: 'rec_li',
              name: '示例人员013',
              openId: 'ou_li',
              position: '运维值班员',
              buildings: ['B楼'],
            },
          ],
        },
      ],
      shiftAssignments: [],
      assignmentRevision: 0,
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain(
      'leave_shift_substitute_MjAyNi0wOC0yNlQwOTowMF9fMjAyNi0wOC0yNlQxODowMA',
    );
    expect(serialized).toContain('2026-08-26');
    expect(serialized).toContain('2026-08-27');
    expect(serialized).toContain('示例人员012');
    expect(serialized).toContain('示例人员008');
    expect(serialized).toContain('示例人员013');
    expect(serialized.match(/"required":true/gu)).toHaveLength(2);
    expect(serialized).toContain(
      'leave_approve_submit:rec_leave_1:supervisor:1:g2:r1',
    );
  });

  it('renders the optional long-white decision before any substitute rows', () => {
    const shiftGroups = [
      {
        shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
        scheduleDate: '2026-08-26',
        startAt: '2026-08-26T09:00',
        endAt: '2026-08-26T18:00',
        kind: 'long_white' as const,
        shift: '长白',
        buildings: ['E楼'],
        teams: ['长白'],
        scheduleRecordIds: ['schedule_long_white_1'],
        leaveHours: 8,
      },
    ];
    const card = buildLeaveApprovalCard({
      ...context,
      applicantName: '示例人员012',
      substituteDecisionRequired: true,
      shiftGroups,
      candidateSets: [
        {
          shiftKey: shiftGroups[0].shiftKey,
          candidates: [
            {
              personRecordId: 'rec_zhang',
              name: '示例人员008',
              openId: 'ou_zhang',
              position: '长白',
              buildings: ['E楼'],
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(card);
    const elements = (card.body as { elements: Array<Record<string, unknown>> })
      .elements;
    const decisionForm = elements.find(
      (element) => element.name === 'leave_substitute_decision',
    ) as { elements: Array<Record<string, unknown>> };
    const decisionSelector = decisionForm.elements.find(
      (element) => element.name === 'leave_substitute_requirement',
    );

    expect(decisionForm).toMatchObject({ tag: 'form' });
    expect(decisionSelector).toMatchObject({
      tag: 'select_static',
      required: true,
    });
    expect(serialized).toContain('leave_substitute_requirement');
    expect(serialized).toContain(
      'leave_substitute_decision_submit:rec_leave_1:supervisor:1',
    );
    expect(serialized).toContain('需要替班');
    expect(serialized).toContain('无需替班');
    expect(serialized).toContain('确认审批');
    expect(serialized).toContain('驳回');
    expect(serialized).not.toContain('逐班次替班安排');
    expect(serialized).not.toContain('rec_zhang');
    expect(serialized).not.toContain('leave_approve_submit:');
  });

  it('renders per-shift rows only after choosing that a substitute is required', () => {
    const shiftGroups = [
      {
        shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
        scheduleDate: '2026-08-26',
        startAt: '2026-08-26T09:00',
        endAt: '2026-08-26T18:00',
        kind: 'long_white' as const,
        shift: '长白',
        buildings: ['E楼'],
        teams: ['长白'],
        scheduleRecordIds: ['schedule_long_white_1'],
        leaveHours: 8,
      },
    ];
    const serialized = JSON.stringify(
      buildLeaveApprovalCard({
        ...context,
        substituteDecisionRequired: true,
        substituteRequiredChoice: true,
        shiftGroups,
        candidateSets: [
          {
            shiftKey: shiftGroups[0].shiftKey,
            candidates: [
              {
                personRecordId: 'rec_zhang',
                name: '示例人员008',
                openId: 'ou_zhang',
                position: '长白',
                buildings: ['E楼'],
              },
            ],
          },
        ],
      }),
    );

    expect(serialized).toContain('逐班次替班安排');
    expect(serialized).toContain('rec_zhang');
    expect(serialized).toContain(
      'leave_approve_submit:rec_leave_1:supervisor:1:g1:r1:d1',
    );
    expect(serialized).not.toContain('leave_substitute_decision_submit:');
  });

  it('hides every substitute row after choosing no substitute', () => {
    const serialized = JSON.stringify(
      buildLeaveApprovalCard({
        ...context,
        substituteDecisionRequired: true,
        substituteRequiredChoice: false,
        shiftGroups: [
          {
            shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
            scheduleDate: '2026-08-26',
            startAt: '2026-08-26T09:00',
            endAt: '2026-08-26T18:00',
            kind: 'long_white',
            shift: '长白',
            buildings: ['H楼'],
            teams: ['长白'],
            scheduleRecordIds: ['schedule_long_white_1'],
            leaveHours: 8,
          },
        ],
      }),
    );

    expect(serialized).toContain('确认审批');
    expect(serialized).toContain('驳回');
    expect(serialized).toContain('"substituteRequired":false');
    expect(serialized).not.toContain('leave_substitute_requirement');
    expect(serialized).not.toContain('leave_substitute_decision_submit:');
    expect(serialized).not.toContain('leave_approve_submit:');
    expect(serialized).not.toContain('逐班次替班安排');
    expect(serialized).not.toContain('leave_shift_substitute_');
  });

  it('shows the rejection reason field only after the reject action is opened', () => {
    const serialized = JSON.stringify(buildLeaveRejectionPromptCard(context));

    expect(serialized).toContain('leave_rejection_reason');
    expect(serialized).toContain(
      'leave_reject_submit:rec_leave_1:supervisor:1',
    );
    expect(serialized).toContain('return_to_approval');
    expect(serialized).toContain('确认驳回');
  });

  it('requires the same substitute selection on a manager-direct card', () => {
    const serialized = JSON.stringify(
      buildLeaveApprovalCard({
        ...context,
        stageKey: 'manager',
        substituteRequired: true,
        substituteCandidates: [
          {
            personRecordId: 'rec_liaoxu',
            name: '示例人员007',
            openId: '',
            position: '实习生（备岗）',
            buildings: ['E楼'],
          },
        ],
      }),
    );

    expect(serialized).toContain('select_static');
    expect(serialized).toContain('leave_approve_submit:rec_leave_1:manager:1');
  });

  it('renders absolute timestamps in Asia/Shanghai instead of raw UTC', () => {
    const serialized = JSON.stringify(
      buildLeaveApprovalCard({
        ...context,
        startAt: '2026-08-18T01:00:00.000Z',
        endAt: '2026-08-18T10:00:00.000Z',
      }),
    );

    expect(serialized).toContain('2026-08-18 09:00 至 2026-08-18 18:00');
    expect(serialized).not.toContain('2026-08-18 01:00');
  });

  it('keeps a disabled terminal action while removing every callback', () => {
    const card = buildLeaveTerminalCard({
      ...context,
      screenshotImageKeys: ['img_v3_leave_evidence_1'],
      screenshotStatus: 'ready',
      outcome: 'approved',
      actorName: '示例人员009',
      message: '示例人员001已同意，待经理审批',
    });
    const serialized = JSON.stringify(card);
    const elements = (card.body as { elements: Array<Record<string, unknown>> })
      .elements;
    const imageIndex = elements.findIndex((element) => element.tag === 'img');
    const resultIndex = elements.findIndex((element) =>
      JSON.stringify(element).includes('处理结果'),
    );

    expect(serialized).not.toContain('callback');
    expect(serialized).toContain('示例人员001已同意，待经理审批');
    expect(serialized).toContain('处理结果');
    expect(serialized).toContain('已处理');
    expect(serialized).toContain('"disabled":true');
    expect(serialized).toContain('img_v3_leave_evidence_1');
    expect(imageIndex).toBeGreaterThan(0);
    expect(resultIndex).toBeGreaterThan(imageIndex);
  });

  it('shows the rejection reason on the terminal result card', () => {
    const serialized = JSON.stringify(
      buildLeaveTerminalCard({
        ...context,
        outcome: 'rejected',
        actorName: '示例人员009',
        message: '请休假申请已驳回',
        rejectionReason: '当日值守力量不足',
      }),
    );

    expect(serialized).toContain('驳回原因');
    expect(serialized).toContain('当日值守力量不足');
    expect(serialized).not.toContain('callback');
  });

  it('renders a rerouted approval card as terminal and removes every callback', () => {
    const serialized = JSON.stringify(
      buildLeaveTerminalCard({
        ...context,
        outcome: 'rerouted',
        actorName: '系统路由修复',
        message: '审批已转交正确负责人，原卡片不可操作',
      }),
    );

    expect(serialized).toContain('请休假审批已转交');
    expect(serialized).toContain('审批已转交正确负责人');
    expect(serialized).toContain('原审批已失效');
    expect(serialized).toContain('"disabled":true');
    expect(serialized).not.toContain('callback');
  });

  it('creates a separate versioned substitute adjustment card after approval', () => {
    const serialized = JSON.stringify(
      buildLeaveSubstituteAdjustmentCard(
        {
          ...context,
          substituteName: '示例人员013',
          substituteRequired: true,
          substituteCandidates: [
            {
              personRecordId: 'rec_substitute_new',
              name: '示例人员017',
              openId: '',
              position: '实习生（备岗）',
              buildings: ['E楼'],
            },
          ],
        },
        2,
      ),
    );

    expect(serialized).toContain('替班调整');
    expect(serialized).toContain('当前替班');
    expect(serialized).toContain('示例人员013');
    expect(serialized).toContain('rec_substitute_new');
    expect(serialized).toContain(
      'leave_substitute_update_submit:rec_leave_1:2',
    );
  });

  it('terminalizes a substitute adjustment card without any callback', () => {
    const serialized = JSON.stringify(
      buildLeaveSubstituteAdjustmentTerminalCard(
        { ...context, substituteName: '示例人员017' },
        '示例人员009',
      ),
    );

    expect(serialized).toContain('替班调整已提交');
    expect(serialized).toContain('示例人员017');
    expect(serialized).not.toContain('callback');
    expect(serialized).not.toContain('form_action_type');
  });

  it.each([
    ['previous_substitute', '原替班安排已取消', '您原承担的替班已取消'],
    ['new_substitute', '新的替班安排', '您已被安排为新的替班人员'],
    ['stakeholder', '替班人员已变更', '审批完成后的替班安排已更新'],
  ] as const)(
    'creates a compact %s substitute-change notification without callbacks',
    (audience, title, message) => {
      const serialized = JSON.stringify(
        buildLeaveSubstituteChangeNotificationCard(
          { ...context, substituteName: '示例人员017' },
          {
            audience,
            previousSubstituteName: '示例人员013',
            substituteName: '示例人员017',
            actorName: '陶必亮',
          },
        ),
      );

      expect(serialized).toContain(title);
      expect(serialized).toContain(message);
      expect(serialized).toContain('示例人员013');
      expect(serialized).toContain('示例人员017');
      expect(serialized).toContain('陶必亮');
      expect(serialized).not.toContain('callback');
      expect(serialized).not.toContain('form_action_type');
    },
  );
});
