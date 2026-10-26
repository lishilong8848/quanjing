import { parseLeaveLongConnectionCardAction } from './leave-workflow.callback';

describe('parseLeaveLongConnectionCardAction', () => {
  it('parses only the explicit leave workflow callback payload', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_approver' },
      context: { open_message_id: 'om_leave_1' },
      action: {
        tag: 'button',
        value: {
          version: 1,
          workflowType: 'leave',
          action: 'approve',
          recordId: 'rec_leave_1',
          applicationKey: 'leave:rec_leave_1',
          stageKey: 'supervisor',
          stageVersion: 1,
        },
      },
    });

    expect(parsed).toMatchObject({
      action: 'approve',
      actorOpenId: 'ou_approver',
      recordId: 'rec_leave_1',
      stageKey: 'supervisor',
      stageVersion: 1,
    });
    expect(parsed.eventId).toMatch(/^ws_leave_/u);
  });

  it('parses final approval from the rebuilt no-substitute card', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_approver' },
      context: { open_message_id: 'om_leave_1' },
      action: {
        tag: 'button',
        value: {
          version: 1,
          workflowType: 'leave',
          action: 'approve',
          recordId: 'rec_leave_1',
          applicationKey: 'leave:rec_leave_1',
          stageKey: 'supervisor',
          stageVersion: 1,
          substituteRequired: false,
        },
      },
    });

    expect(parsed).toMatchObject({
      kind: 'approval',
      action: 'approve',
      substituteRequired: false,
    });
  });

  it.each([
    ['required', 'view', 'substitute_required'],
    ['not_required', 'approval', undefined],
  ] as const)(
    'parses the submitted %s substitute decision form',
    (decision, kind, view) => {
      const parsed = parseLeaveLongConnectionCardAction({
        event_type: 'card.action.trigger',
        operator: { open_id: 'ou_approver' },
        context: { open_message_id: 'om_leave_1' },
        action: {
          tag: 'button',
          name: 'leave_substitute_decision_submit:rec_leave_1:supervisor:1',
          form_value: {
            leave_substitute_requirement: decision,
          },
        },
      });

      expect(parsed).toMatchObject({
        kind,
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
        ...(view ? { view } : { action: 'approve', substituteRequired: false }),
      });
    },
  );

  it.each([
    ['required', 'substitute_required'],
    ['not_required', 'substitute_not_required'],
  ] as const)(
    'parses an immediate %s substitute decision card view',
    (option, view) => {
      const parsed = parseLeaveLongConnectionCardAction({
        event_type: 'card.action.trigger',
        operator: { open_id: 'ou_approver' },
        context: { open_message_id: 'om_leave_1' },
        action: {
          tag: 'select_static',
          option,
          value: {
            version: 1,
            workflowType: 'leave',
            action: 'select_substitute_requirement',
            recordId: 'rec_leave_1',
            applicationKey: 'leave:rec_leave_1',
            stageKey: 'supervisor',
            stageVersion: 1,
          },
        },
      });

      expect(parsed).toMatchObject({
        kind: 'view',
        view,
        recordId: 'rec_leave_1',
        stageKey: 'supervisor',
        stageVersion: 1,
      });
    },
  );

  it('parses an in-form substitute decision from the real Feishu form_value shape', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_approver' },
      context: { open_message_id: 'om_leave_1' },
      action: {
        tag: 'select_static',
        form_value: {
          leave_substitute_requirement: 'required',
        },
        value: {
          version: 1,
          workflowType: 'leave',
          action: 'select_substitute_requirement',
          recordId: 'rec_leave_1',
          applicationKey: 'leave:rec_leave_1',
          stageKey: 'supervisor',
          stageVersion: 1,
        },
      },
    });

    expect(parsed).toMatchObject({
      kind: 'view',
      view: 'substitute_required',
      recordId: 'rec_leave_1',
      stageKey: 'supervisor',
      stageVersion: 1,
    });
  });

  it('parses a rebuilt required-substitute form without trusting hidden form state', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_approver' },
      context: { open_message_id: 'om_leave_1' },
      action: {
        tag: 'button',
        name: 'leave_approve_submit:rec_leave_1:supervisor:1:g1:r1:d1',
        form_value: {
          leave_shift_substitute_MjAyNi0wOC0yNlQwOTowMF9fMjAyNi0wOC0yNlQxODowMA:
            'rec_zhang',
        },
      },
    });

    expect(parsed).toMatchObject({
      kind: 'approval',
      substituteRequired: true,
    });
  });

  it('rejects another workflow before it can enter the leave handler', () => {
    expect(() =>
      parseLeaveLongConnectionCardAction({
        action: { tag: 'button', value: { workflowType: 'overtime' } },
      }),
    ).toThrow('非请休假审批卡片回调');
  });

  it('parses the substitute person selected by a supervisor form submit', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_approver' },
      context: { open_message_id: 'om_leave_1' },
      action: {
        tag: 'button',
        name: 'leave_approve_submit:rec_leave_1:supervisor:1',
        form_value: {
          leave_substitute_person_record_id: 'rec_substitute',
        },
      },
    });

    expect(parsed).toMatchObject({
      action: 'approve',
      recordId: 'rec_leave_1',
      stageKey: 'supervisor',
      stageVersion: 1,
      substitutePersonRecordId: 'rec_substitute',
    });
  });

  it('parses an exact multi-shift substitute mapping', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_approver' },
      context: { open_message_id: 'om_leave_multi_1' },
      action: {
        tag: 'button',
        name: 'leave_approve_submit:rec_leave_1:supervisor:1:g2:r1',
        form_value: {
          leave_shift_substitute_MjAyNi0wOC0yNlQwOTowMF9fMjAyNi0wOC0yNlQxODowMA:
            'rec_zhang',
          leave_shift_substitute_MjAyNi0wOC0yN1QxODowMF9fMjAyNi0wOC0yOFQwOTowMA:
            'rec_li',
        },
      },
    });

    expect(parsed).toMatchObject({
      kind: 'approval',
      shiftSelections: [
        {
          shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
          substitutePersonRecordId: 'rec_zhang',
        },
        {
          shiftKey: '2026-08-27T18:00__2026-08-28T09:00',
          substitutePersonRecordId: 'rec_li',
        },
      ],
    });
  });

  it.each([
    ['required', true, 'rec_zhang'],
    ['not_required', false, undefined],
  ] as const)(
    'parses a long-white %s decision with conditional shift selections',
    (decision, substituteRequired, selectedRecordId) => {
      const fieldName =
        'leave_shift_substitute_MjAyNi0wOC0yNlQwOTowMF9fMjAyNi0wOC0yNlQxODowMA';
      const parsed = parseLeaveLongConnectionCardAction({
        event_type: 'card.action.trigger',
        operator: { open_id: 'ou_approver' },
        context: { open_message_id: 'om_leave_long_white_1' },
        action: {
          tag: 'button',
          name: 'leave_approve_submit:rec_leave_1:supervisor:1:g1:r0:o1',
          form_value: {
            leave_substitute_requirement: decision,
            ...(selectedRecordId ? { [fieldName]: selectedRecordId } : {}),
          },
        },
      });

      expect(parsed).toMatchObject({
        kind: 'approval',
        substituteRequired,
        shiftSelections: selectedRecordId
          ? [
              {
                shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
                substitutePersonRecordId: selectedRecordId,
              },
            ]
          : [],
      });
    },
  );

  it('rejects a long-white approval form without the required decision', () => {
    expect(() =>
      parseLeaveLongConnectionCardAction({
        event_type: 'card.action.trigger',
        operator: { open_id: 'ou_approver' },
        context: { open_message_id: 'om_leave_long_white_missing' },
        action: {
          tag: 'button',
          name: 'leave_approve_submit:rec_leave_1:supervisor:1:g1:r0:o1',
          form_value: {},
        },
      }),
    ).toThrow('请选择是否需要替班');
  });

  it.each([
    [
      'malformed token',
      {
        leave_shift_substitute_not_valid$: 'rec_zhang',
      },
    ],
    [
      'unknown form field',
      {
        unexpected_field: 'rec_zhang',
      },
    ],
    [
      'absent required selection',
      {
        leave_shift_substitute_MjAyNi0wOC0yNlQwOTowMF9fMjAyNi0wOC0yNlQxODowMA:
          'rec_zhang',
      },
    ],
  ])('rejects %s in a multi-shift form', (_label, formValue) => {
    expect(() =>
      parseLeaveLongConnectionCardAction({
        operator: { open_id: 'ou_approver' },
        context: { open_message_id: 'om_leave_multi_invalid' },
        action: {
          tag: 'button',
          name: 'leave_approve_submit:rec_leave_1:supervisor:1:g2:r1',
          form_value: formValue,
        },
      }),
    ).toThrow();
  });

  it('rejects duplicate decoded shift keys', () => {
    expect(() =>
      parseLeaveLongConnectionCardAction({
        operator: { open_id: 'ou_approver' },
        context: { open_message_id: 'om_leave_multi_duplicate' },
        action: {
          tag: 'button',
          name: 'leave_approve_submit:rec_leave_1:supervisor:1:g2:r1',
          form_value: {
            leave_shift_substitute_MA: 'rec_zhang',
            leave_shift_substitute_MB: 'rec_li',
          },
        },
      }),
    ).toThrow();
  });

  it('limits mapping field count and total decoded payload size', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `leave_shift_substitute_${Buffer.from(`shift-${index}`).toString('base64url')}`,
        'rec_zhang',
      ]),
    );
    const oversized = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `leave_shift_substitute_${Buffer.from(`shift-${index}`).toString('base64url')}`,
        `rec_${'x'.repeat(300)}`,
      ]),
    );
    const parse = (formValue: Record<string, string>) =>
      parseLeaveLongConnectionCardAction({
        operator: { open_id: 'ou_approver' },
        context: { open_message_id: 'om_leave_multi_limit' },
        action: {
          tag: 'button',
          name: 'leave_approve_submit:rec_leave_1:manager:1:g64:r0',
          form_value: formValue,
        },
      });

    expect(() => parse(tooMany)).toThrow();
    expect(() => parse(oversized)).toThrow();
  });

  it('preserves the manager stage on a manager-direct substitute form submit', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_manager' },
      context: { open_message_id: 'om_leave_manager_1' },
      action: {
        tag: 'button',
        name: 'leave_approve_submit:rec_leave_manager:manager:1',
        form_value: {
          leave_substitute_person_record_id: 'rec_substitute',
        },
      },
    });

    expect(parsed).toMatchObject({
      action: 'approve',
      recordId: 'rec_leave_manager',
      stageKey: 'manager',
      stageVersion: 1,
      substitutePersonRecordId: 'rec_substitute',
    });
  });

  it('parses a required rejection reason from the reject form', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_manager' },
      context: { open_message_id: 'om_leave_manager_2' },
      action: {
        tag: 'button',
        name: 'leave_reject_submit:rec_leave_manager:manager:2',
        form_value: { leave_rejection_reason: '当日保障力量不足' },
      },
    });

    expect(parsed).toMatchObject({
      action: 'reject',
      recordId: 'rec_leave_manager',
      stageKey: 'manager',
      stageVersion: 2,
      rejectionReason: '当日保障力量不足',
    });
  });

  it('parses opening the rejection view without treating it as a business decision', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_manager' },
      context: { open_message_id: 'om_leave_manager_2' },
      action: {
        tag: 'button',
        value: {
          version: 1,
          workflowType: 'leave',
          action: 'open_rejection',
          recordId: 'rec_leave_manager',
          applicationKey: 'leave:rec_leave_manager',
          stageKey: 'manager',
          stageVersion: 2,
        },
      },
    });

    expect(parsed).toMatchObject({
      kind: 'view',
      view: 'rejection',
      recordId: 'rec_leave_manager',
      stageKey: 'manager',
      stageVersion: 2,
    });
  });

  it('parses a versioned substitute adjustment form', () => {
    const parsed = parseLeaveLongConnectionCardAction({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_manager' },
      context: { open_message_id: 'om_leave_adjustment_1' },
      action: {
        tag: 'button',
        name: 'leave_substitute_update_submit:rec_leave_manager:2',
        form_value: {
          leave_substitute_person_record_id: 'rec_substitute_new',
        },
      },
    });

    expect(parsed).toMatchObject({
      kind: 'substitute_update',
      recordId: 'rec_leave_manager',
      expectedRevision: 2,
      substitutePersonRecordId: 'rec_substitute_new',
    });
  });
});
