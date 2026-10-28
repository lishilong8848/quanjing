import type {
  LeaveApprovalStageKey,
  LeaveShiftCandidateSet,
  LeaveShiftAssignmentSelection,
  LeaveShiftSubstituteAssignment,
  LeaveSubstituteCandidate,
} from './leave-workflow.types';
import type { LeaveRequestShiftGroup } from '../../../shared/leave-request-impact';
import { originalPostSignature } from './leave-two-level-substitution';
import { leaveBackfillFieldName } from './leave-workflow.form-fields';

const CARD_MAX_BYTES = 30 * 1024;
const LEAVE_SHIFT_FIELD_PREFIX = 'leave_shift_substitute_';

export interface LeaveCardContext {
  recordId: string;
  applicationKey: string;
  stageKey: LeaveApprovalStageKey;
  stageVersion: number;
  applicantName: string;
  building: string;
  position: string;
  leaveType: string;
  startAt: string;
  endAt: string;
  leaveHours: number;
  approvalDayCount: number;
  reason: string;
  screenshotImageKeys?: string[];
  screenshotStatus?: 'ready' | 'missing' | 'unavailable';
  substituteName?: string;
  substituteRequired?: boolean;
  substituteDecisionRequired?: boolean;
  substituteRequiredChoice?: boolean;
  substituteCandidates?: LeaveSubstituteCandidate[];
  shiftGroups?: LeaveRequestShiftGroup[];
  candidateSets?: LeaveShiftCandidateSet[];
  shiftAssignments?: LeaveShiftSubstituteAssignment[];
  assignmentRevision?: number;
  substitutionReview?: LeaveShiftAssignmentSelection[];
}

export function buildLeaveApprovalCard(
  context: LeaveCardContext,
): Record<string, unknown> {
  let card: Record<string, unknown>;
  if (context.substituteDecisionRequired) {
    const substituteDecision = context.substituteRequiredChoice;
    card = buildCard('blue', titleForStage(context), [
      ...summary(context),
      ...approvalEvidence(context),
      ...(substituteDecision === true
        ? [substituteApprovalForm(context)]
        : substituteDecision === false
          ? [fullWidthAction('确认审批', 'primary_filled', 'approve', context)]
          : [substituteDecisionForm(context)]),
      ...(substituteDecision === true ? substituteReviewNavigation(context, 'approval') : []),
      fullWidthViewAction('驳回', 'danger', 'open_rejection', context),
    ]);
  } else if (context.substituteRequired) {
    card = buildCard('blue', titleForStage(context), [
      ...summary(context),
      ...approvalEvidence(context),
      substituteApprovalForm(context),
      ...substituteReviewNavigation(context, 'approval'),
      fullWidthViewAction('驳回', 'danger', 'open_rejection', context),
    ]);
  } else {
    card = buildCard('blue', titleForStage(context), [
      ...summary(context),
      ...approvalEvidence(context),
      fullWidthAction('同意', 'primary_filled', 'approve', context),
      fullWidthViewAction('驳回', 'danger', 'open_rejection', context),
    ]);
  }
  return assertMultiShiftCardSize(card, context.shiftGroups?.length || 0);
}

export function buildLeaveRejectionPromptCard(
  context: LeaveCardContext,
): Record<string, unknown> {
  return buildCard('red', `${applicationTitle(context)} · 填写驳回原因`, [
    ...summary(context),
    ...approvalEvidence(context),
    {
      tag: 'markdown',
      content:
        '<font color="grey">尚未提交驳回；填写原因并确认后才会改变审批状态。</font>',
    },
    rejectionForm(context),
    fullWidthViewAction('取消驳回', 'default', 'return_to_approval', context),
  ]);
}

function substituteDecisionForm(
  context: LeaveCardContext,
): Record<string, unknown> {
  return {
    tag: 'form',
    name: 'leave_substitute_decision',
    elements: [
      substituteRequirementSelector(context),
      {
        tag: 'button',
        name: `leave_substitute_decision_submit:${context.recordId}:${context.stageKey}:${context.stageVersion}`,
        type: 'primary_filled',
        width: 'fill',
        form_action_type: 'submit',
        text: { tag: 'plain_text', content: '确认审批' },
      },
    ],
  };
}

function substituteApprovalForm(
  context: LeaveCardContext,
  includeOptionalDecision = false,
): Record<string, unknown> {
  if (context.shiftGroups?.length) {
    return multiShiftSubstituteForm(
      context,
      'approval',
      includeOptionalDecision,
    );
  }
  const hasCurrentSubstitute = Boolean(context.substituteName);
  const decisionResolved = context.substituteRequiredChoice === true;
  const showSubstituteSelection =
    !includeOptionalDecision || context.substituteRequiredChoice === true;
  return {
    tag: 'form',
    name: includeOptionalDecision
      ? 'leave_optional_substitute_approval'
      : 'leave_substitute_approval',
    elements: [
      ...(includeOptionalDecision
        ? [substituteRequirementSelector(context)]
        : []),
      ...(showSubstituteSelection
        ? [
            {
              tag: 'markdown',
              content: `**替班安排**${hasCurrentSubstitute ? '' : '  <font color="red">必填</font>'}\n<font color="grey">${
                hasCurrentSubstitute
                  ? `当前：${escape(context.substituteName)}；可重新选择，未改选则沿用当前人员`
                  : '请选择本次请休假的实际替班人员'
              }</font>`,
            },
            {
              tag: 'select_static',
              name: 'leave_substitute_person_record_id',
              required: !hasCurrentSubstitute,
              width: 'fill',
              placeholder: { tag: 'plain_text', content: '选择替班人员' },
              options: (context.substituteCandidates || []).map((person) => ({
                text: { tag: 'plain_text', content: person.name },
                value: person.personRecordId,
              })),
            },
          ]
        : []),
      {
        tag: 'button',
        name: `leave_approve_submit:${context.recordId}:${context.stageKey}:${context.stageVersion}${includeOptionalDecision ? ':o1' : decisionResolved ? ':d1' : ''}`,
        type: 'primary_filled',
        width: 'fill',
        form_action_type: 'submit',
        text: {
          tag: 'plain_text',
          content: decisionResolved ? '确认审批' : '同意并确认替班人员',
        },
      },
    ],
  };
}

function multiShiftSubstituteForm(
  context: LeaveCardContext,
  mode: 'approval' | 'adjustment',
  includeOptionalDecision = false,
): Record<string, unknown> {
  const groups = context.shiftGroups || [];
  const currentByShiftKey = new Map(
    (context.shiftAssignments || []).map(
      (assignment) => [assignment.shiftKey, assignment] as const,
    ),
  );
  const candidatesByShiftKey = new Map(
    (context.candidateSets || []).map(
      (set) => [set.shiftKey, set.candidates] as const,
    ),
  );
  const reviewByShiftKey = new Map((context.substitutionReview || []).map((selection) => [selection.shiftKey, selection]));
  const reviewing = context.substitutionReview !== undefined;
  const hasOnDutyChoices = (context.candidateSets || []).some((set) => set.twoLevelCandidates?.some((choice) => choice.originalGroups.length > 0));
  const requireEverySelection =
    mode === 'approval' &&
    (!context.substituteDecisionRequired ||
      context.substituteRequiredChoice === true) &&
    groups.some((group) => !currentByShiftKey.has(group.shiftKey));
  const showShiftElements =
    !includeOptionalDecision || context.substituteRequiredChoice === true;
  const shiftElements = showShiftElements
    ? groups.flatMap((group) => {
        const current = currentByShiftKey.get(group.shiftKey);
        const selected = reviewByShiftKey.get(group.shiftKey);
        const choices = context.candidateSets?.find((set) => set.shiftKey === group.shiftKey)?.twoLevelCandidates || [];
        const selectedChoice = choices.find((choice) => choice.person.personRecordId === selected?.substitutePersonRecordId);
        if (reviewing && !selectedChoice) throw new Error('替班人员已不可选，请重新选择');
        return [
          shiftSubstituteDetail(group, current),
          {
            tag: 'select_static',
            name: shiftSubstituteFieldName(group.shiftKey),
            required: reviewing || requireEverySelection,
            width: 'fill',
            placeholder: {
              tag: 'plain_text',
              content: current ? '不修改则沿用当前人员' : '选择该班次替班人员',
            },
            ...(reviewing ? { initial_option: selected!.substitutePersonRecordId } : {}),
            options: (candidatesByShiftKey.get(group.shiftKey) || []).filter((person) => !reviewing || person.personRecordId === selected!.substitutePersonRecordId).map(
              (person) => ({
                text: { tag: 'plain_text', content: `${person.name}${choices.find((choice) => choice.person.personRecordId === person.personRecordId)?.originalGroups.map((original) => ` · ${original.buildings.join('/')} ${original.shift}`).join('') || ''}` },
                value: person.personRecordId,
              }),
            ),
          },
          ...(reviewing && selectedChoice?.originalGroups.length ? [
            {
              tag: 'markdown',
              content: `**原岗补位 · ${escape(selectedChoice.person.name)}**\n${selectedChoice.originalGroups.map((original) => `${escape(original.buildings.join('、'))} ${escape(original.shift)} · ${escape(formatTime(original.startAt))} 至 ${escape(formatTime(original.endAt))}`).join('\n')}`,
            },
            {
              tag: 'select_static',
              name: leaveBackfillFieldName(group.shiftKey, selectedChoice.person.personRecordId, originalPostSignature(selectedChoice.originalGroups)),
              required: true,
              width: 'fill',
              placeholder: { tag: 'plain_text', content: '选择原岗补位人员' },
              options: selectedChoice.backfillCandidates.map((person) => ({ text: { tag: 'plain_text', content: person.name }, value: person.personRecordId })),
              ...(selected?.backfillPersonRecordId ? { initial_option: selected.backfillPersonRecordId } : {}),
            },
          ] : []),
        ];
      })
    : [];
  const actionName =
    mode === 'approval'
      ? `${hasOnDutyChoices && !reviewing ? 'leave_substitute_review_submit' : 'leave_approve_submit'}:${context.recordId}:${context.stageKey}:${context.stageVersion}:g${groups.length}:r${requireEverySelection ? 1 : 0}${includeOptionalDecision ? ':o1' : context.substituteRequiredChoice === true ? ':d1' : ''}`
      : `${hasOnDutyChoices && !reviewing ? 'leave_substitute_review_update_submit' : 'leave_substitute_update_submit'}:${context.recordId}:${context.assignmentRevision || 0}:g${groups.length}:r${reviewing ? 1 : 0}`;
  return {
    tag: 'form',
    name: includeOptionalDecision
      ? 'leave_optional_substitute_approval'
      : mode === 'approval'
        ? 'leave_shift_substitute_approval'
        : 'leave_shift_substitute_adjustment',
    elements: [
      ...(includeOptionalDecision
        ? [substituteRequirementSelector(context)]
        : []),
      ...(showShiftElements
        ? [
            {
              tag: 'markdown',
              content:
                mode === 'approval'
                  ? `**逐班次替班安排**${requireEverySelection ? '  <font color="red">每班必填</font>' : ''}`
                  : '**逐班次调整**  <font color="grey">只选择需要修改的班次</font>',
            },
            ...shiftElements,
          ]
        : []),
      {
        tag: 'button',
        name: actionName,
        type: 'primary_filled',
        width: 'fill',
        form_action_type: 'submit',
        text: {
          tag: 'plain_text',
          content:
            mode === 'adjustment'
              ? '提交替班调整'
              : hasOnDutyChoices && !reviewing
              ? '核对替班安排'
              : context.substituteDecisionRequired
                ? '确认审批'
                : '同意并确认全部替班',
        },
      },
    ],
  };
}

function substituteReviewNavigation(
  context: LeaveCardContext,
  mode: 'approval' | 'adjustment',
): Record<string, unknown>[] {
  if (mode === 'approval') {
    if (!context.shiftGroups?.length || context.substitutionReview === undefined) return [];
    return [fullWidthViewAction('重新选择', 'default', 'return_to_approval', context)];
  }
  return [substituteAdjustmentViewAction('重新选择', context)];
}

function substituteAdjustmentViewAction(
  label: '调整人员' | '重新选择',
  context: LeaveCardContext,
): Record<string, unknown> {
  return {
    tag: 'button',
    type: label === '调整人员' ? 'primary_filled' : 'default',
    width: 'fill',
    text: { tag: 'plain_text', content: label },
    behaviors: [{
      type: 'callback',
      value: {
        version: 1,
        workflowType: 'leave',
        action: 'return_to_substitute_adjustment',
        recordId: context.recordId,
        expectedRevision: context.assignmentRevision || 0,
      },
    }],
  };
}

function shiftSubstituteDetail(
  group: LeaveRequestShiftGroup,
  current?: LeaveShiftSubstituteAssignment,
): Record<string, unknown> {
  const location = [...group.buildings, ...group.teams].filter(Boolean).join(' · ');
  return {
    tag: 'markdown',
    content: `**${escape(group.scheduleDate)} ${escape(group.shift)}**${
      location ? `  <font color="grey">${escape(location)}</font>` : ''
    }\n<font color="grey">${escape(formatTime(group.startAt))} 至 ${escape(
      formatTime(group.endAt),
    )}${current ? ` · 当前：${escape(current.substituteName)}` : ''}</font>`,
  };
}

function substituteRequirementSelector(
  context: LeaveCardContext,
): Record<string, unknown> {
  const choice = context.substituteRequiredChoice;
  return {
    tag: 'select_static',
    name: 'leave_substitute_requirement',
    required: true,
    width: 'fill',
    placeholder: { tag: 'plain_text', content: '选择是否需要替班' },
    ...(typeof choice === 'boolean'
      ? { initial_option: choice ? 'required' : 'not_required' }
      : {}),
    options: [
      {
        text: { tag: 'plain_text', content: '需要替班' },
        value: 'required',
      },
      {
        text: { tag: 'plain_text', content: '无需替班' },
        value: 'not_required',
      },
    ],
  };
}

function shiftSubstituteFieldName(shiftKey: string): string {
  return `${LEAVE_SHIFT_FIELD_PREFIX}${Buffer.from(shiftKey, 'utf8').toString(
    'base64url',
  )}`;
}

function rejectionForm(context: LeaveCardContext): Record<string, unknown> {
  return {
    tag: 'form',
    name: 'leave_rejection_form',
    direction: 'vertical',
    vertical_spacing: '8px',
    elements: [
      {
        tag: 'input',
        name: 'leave_rejection_reason',
        required: true,
        input_type: 'multiline_text',
        max_length: 500,
        rows: 2,
        width: 'fill',
        label: { tag: 'plain_text', content: '驳回原因' },
        placeholder: {
          tag: 'plain_text',
          content: '驳回时必填，2–500 字',
        },
      },
      {
        tag: 'button',
        name: `leave_reject_submit:${context.recordId}:${context.stageKey}:${context.stageVersion}`,
        type: 'danger',
        width: 'fill',
        form_action_type: 'submit',
        text: { tag: 'plain_text', content: '确认驳回' },
      },
    ],
  };
}

export function buildLeaveProgressCard(
  context: LeaveCardContext,
): Record<string, unknown> {
  return buildCard('blue', `${applicationTitle(context)}已提交`, [
    ...summary(context),
    {
      tag: 'markdown',
      content: '<font color="blue">审批处理中，结果将继续同步到此账号。</font>',
    },
  ]);
}

export function buildLeaveSubstituteAdjustmentCard(
  context: LeaveCardContext,
  expectedRevision: number,
  showEditor = context.substitutionReview !== undefined,
): Record<string, unknown> {
  const cardContext = { ...context, assignmentRevision: expectedRevision };
  const form = !showEditor ? undefined : context.shiftGroups?.length
    ? multiShiftSubstituteForm(cardContext, 'adjustment')
    : {
        tag: 'form',
        name: 'leave_substitute_adjustment',
        elements: [
          {
            tag: 'select_static',
            name: 'leave_substitute_person_record_id',
            required: true,
            width: 'fill',
            placeholder: { tag: 'plain_text', content: '选择新的替班人员' },
            options: (context.substituteCandidates || []).map((person) => ({
              text: { tag: 'plain_text', content: person.name },
              value: person.personRecordId,
            })),
          },
          {
            tag: 'button',
            name: `leave_substitute_update_submit:${context.recordId}:${expectedRevision}`,
            type: 'primary_filled',
            width: 'fill',
            form_action_type: 'submit',
            text: { tag: 'plain_text', content: '提交替班调整' },
          },
        ],
      };
  const card = buildCard('orange', '请休假替班调整', [
    ...summary(context),
    ...(context.shiftGroups?.length
      ? []
      : [detail('当前替班', context.substituteName || '未安排')]),
    ...(form ? [form, ...substituteReviewNavigation(cardContext, 'adjustment')] : [
      ...(context.shiftGroups || []).map(group => shiftSubstituteDetail(
        group, context.shiftAssignments?.find(assignment => assignment.shiftKey === group.shiftKey),
      )),
      { tag: 'markdown', content: '<font color="grey">人员无误，无需点击调整。</font>' },
      substituteAdjustmentViewAction('调整人员', cardContext),
    ]),
  ]);
  return assertMultiShiftCardSize(card, context.shiftGroups?.length || 0);
}

export function buildLeaveSubstituteAdjustmentTerminalCard(
  context: LeaveCardContext,
  actorName: string,
): Record<string, unknown> {
  return buildCard('green', '替班调整已提交', [
    ...summary(context),
    detail('当前替班', context.substituteName || '未安排'),
    detail('调整人', actorName),
    {
      tag: 'markdown',
      content: '<font color="green">调整已受理，后台正在同步多维表。</font>',
    },
  ]);
}

export function buildLeaveSubstituteChangeNotificationCard(
  context: LeaveCardContext,
  input: {
    audience: 'previous_substitute' | 'new_substitute' | 'stakeholder';
    previousSubstituteName: string;
    substituteName: string;
    actorName: string;
    shiftChangeSummary?: string;
  },
): Record<string, unknown> {
  const presentation =
    input.audience === 'previous_substitute'
      ? {
          template: 'orange' as const,
          title: '原替班安排已取消',
          message: '您原承担的替班已取消',
        }
      : input.audience === 'new_substitute'
        ? {
            template: 'blue' as const,
            title: '新的替班安排',
            message: '您已被安排为新的替班人员',
          }
        : {
            template: 'orange' as const,
            title: '替班人员已变更',
            message: '审批完成后的替班安排已更新',
          };
  return buildCard(presentation.template, presentation.title, [
    ...summary(context),
    {
      tag: 'markdown',
      content: `<font color="${input.audience === 'new_substitute' ? 'blue' : 'orange'}">${escape(presentation.message)}</font>`,
    },
    detail(
      '替班变更',
      input.shiftChangeSummary ||
        `${input.previousSubstituteName || '未安排'} → ${input.substituteName}`,
    ),
    detail('调整人', input.actorName || '审批人'),
  ]);
}

export function buildLeaveTerminalCard(
  input: LeaveCardContext & {
    outcome: LeaveTerminalOutcome;
    actorName: string;
    message: string;
    rejectionReason?: string;
  },
): Record<string, unknown> {
  const template =
    input.outcome === 'rejected'
      ? 'red'
      : input.outcome === 'approved'
        ? 'green'
        : input.outcome === 'routing_invalidated'
          ? 'red'
          : 'orange';
  const title =
    input.outcome === 'rejected'
      ? '请休假申请已驳回'
      : input.outcome === 'approved'
        ? '请休假申请已通过'
        : input.outcome === 'rerouted'
          ? '请休假审批已转交'
          : input.outcome === 'routing_invalidated'
            ? '请休假审批路由异常'
            : '请休假申请阶段已完成';
  return buildCard(template, title, [
    ...summary(input),
    ...approvalEvidence(input),
    resultSummary(input.actorName, input.message, input.outcome),
    ...(input.outcome === 'rejected' && input.rejectionReason
      ? [detail('驳回原因', input.rejectionReason)]
      : []),
    disabledActionRow(input.outcome),
  ]);
}

function buildCard(
  template: 'blue' | 'green' | 'orange' | 'red',
  title: string,
  elements: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      vertical_spacing: '8px',
      elements,
    },
  };
}

function applicationTitle(context: LeaveCardContext): string {
  return context.leaveType === '差旅' ? '差旅申请' : '请休假申请';
}

function titleForStage(context: LeaveCardContext): string {
  return context.stageKey === 'manager'
    ? `${applicationTitle(context)} · 待经理审批`
    : `${applicationTitle(context)} · 待主管审批`;
}

function summary(context: LeaveCardContext): Array<Record<string, unknown>> {
  const identityDetails = [
    normalizeCardBuilding(context.building),
    stripInternalIdentifiers(context.position),
  ]
    .filter(Boolean)
    .join(' · ');
  return [
    {
      tag: 'markdown',
      content: `**${escape(stripInternalIdentifiers(context.applicantName))}**${
        identityDetails
          ? `  <font color="grey">${escape(identityDetails)}</font>`
          : ''
      }`,
    },
    {
      tag: 'markdown',
      content: '**申请概览**',
    },
    {
      tag: 'column_set',
      horizontal_spacing: '8px',
      columns: [
        metricColumn('类型', context.leaveType),
        metricColumn('申请工时', `${formatHours(context.leaveHours)} 小时`),
        metricColumn('审批天数', `${formatHours(context.approvalDayCount)} 天`),
      ],
    },
    detail(
      '申请时段',
      `${formatTime(context.startAt)} 至 ${formatTime(context.endAt)}`,
    ),
    detail('原因', context.reason),
    ...((context.shiftAssignments || []).length
      ? [
          {
            tag: 'markdown',
            content: `**逐班次替班**\n${[...(context.shiftAssignments || [])]
              .sort((left, right) =>
                left.shiftKey.localeCompare(right.shiftKey),
              )
              .map(
                (assignment) =>
                  `${escape(assignment.scheduleDate)} ${escape(
                    assignment.shift,
                  )}：**${escape(assignment.substituteName)}**${(assignment.originalPostBackfills || []).map((backup) => `\n原岗补位 ${escape(backup.group.buildings.join('、'))} ${escape(backup.group.scheduleDate)} ${escape(backup.group.shift)} ${escape(backup.group.startAt.slice(11))}–${escape(backup.group.endAt.slice(11))}：**${escape(backup.substituteName)}**`).join('')}`,
              )
              .join('\n')}`,
          },
        ]
      : []),
    ...(context.substituteName
      ? [detail('替班人员', context.substituteName)]
      : []),
  ];
}

function approvalEvidence(
  context: LeaveCardContext,
): Array<Record<string, unknown>> {
  const imageKey = (context.screenshotImageKeys || []).find((value) =>
    /^img_[A-Za-z0-9_-]{1,300}$/u.test(String(value || '').trim()),
  );
  if (imageKey) {
    return [
      {
        tag: 'markdown',
        content: '**流程截图**  <font color="grey">审批依据</font>',
      },
      {
        tag: 'img',
        img_key: imageKey,
        alt: { tag: 'plain_text', content: '请休假流程截图' },
      },
    ];
  }
  if (
    context.screenshotStatus === 'missing' ||
    context.screenshotStatus === 'unavailable'
  ) {
    return [
      {
        tag: 'markdown',
        content:
          context.screenshotStatus === 'missing'
            ? '**流程截图**  <font color="orange">未找到已提交截图</font>'
            : '**流程截图**  <font color="orange">截图暂不可预览，不影响审批操作</font>',
      },
    ];
  }
  return [];
}

function metricColumn(label: string, value: unknown): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'markdown',
        content: `**${escape(display(value))}**\n<font color="grey">${escape(label)}</font>`,
      },
    ],
  };
}

function detail(label: string, value: unknown): Record<string, unknown> {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `<font color="grey">${escape(label)}</font>\n**${escape(display(value))}**`,
    },
  };
}

function resultSummary(
  actorName: string,
  message: string,
  outcome: LeaveTerminalOutcome,
): Record<string, unknown> {
  const color =
    outcome === 'rejected' || outcome === 'routing_invalidated'
      ? 'red'
      : outcome === 'approved'
        ? 'green'
        : 'orange';
  return {
    tag: 'markdown',
    content: `**处理结果**\n<font color="${color}">${escape(message)}</font>\n<font color="grey">处理人：${escape(actorName)}</font>`,
  };
}

function disabledActionRow(
  outcome: LeaveTerminalOutcome,
): Record<string, unknown> {
  if (outcome === 'rerouted' || outcome === 'routing_invalidated') {
    return {
      tag: 'column_set',
      horizontal_spacing: '8px',
      columns: [
        disabledActionColumn('原审批已失效'),
        disabledActionColumn('不可操作'),
      ],
    };
  }
  const approved = outcome !== 'rejected';
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: [
      disabledActionColumn(approved ? '已同意' : '同意'),
      disabledActionColumn(approved ? '驳回' : '已驳回'),
    ],
  };
}

type LeaveTerminalOutcome =
  | 'approved'
  | 'rejected'
  | 'stage_approved'
  | 'rerouted'
  | 'routing_invalidated';

function disabledActionColumn(label: string): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'button',
        type: 'default',
        width: 'fill',
        disabled: true,
        disabled_tips: { tag: 'plain_text', content: '该申请已处理' },
        text: { tag: 'plain_text', content: label },
      },
    ],
  };
}

function actionColumn(
  label: string,
  type: 'primary_filled' | 'danger',
  action: 'approve' | 'reject',
  context: LeaveCardContext,
): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'button',
        type,
        width: 'fill',
        text: { tag: 'plain_text', content: label },
        behaviors: [
          {
            type: 'callback',
            value: {
              version: 1,
              workflowType: 'leave',
              action,
              recordId: context.recordId,
              applicationKey: context.applicationKey,
              stageKey: context.stageKey,
              stageVersion: context.stageVersion,
              ...(context.substituteRequiredChoice === false
                ? { substituteRequired: false }
                : {}),
            },
          },
        ],
      },
    ],
  };
}

function fullWidthAction(
  label: string,
  type: 'primary_filled' | 'danger',
  action: 'approve',
  context: LeaveCardContext,
): Record<string, unknown> {
  return actionColumn(label, type, action, context).elements[0] as Record<
    string,
    unknown
  >;
}

function fullWidthViewAction(
  label: string,
  type: 'default' | 'danger',
  action: 'open_rejection' | 'return_to_approval',
  context: LeaveCardContext,
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    width: 'fill',
    text: { tag: 'plain_text', content: label },
    behaviors: [
      {
        type: 'callback',
        value: {
          version: 1,
          workflowType: 'leave',
          action,
          recordId: context.recordId,
          applicationKey: context.applicationKey,
          stageKey: context.stageKey,
          stageVersion: context.stageVersion,
        },
      },
    ],
  };
}

function formatTime(value: string): string {
  const timestamp = Date.parse(display(value));
  if (!Number.isFinite(timestamp)) return display(value).replace(/T/u, ' ');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`;
}

function normalizeCardBuilding(value: unknown): string {
  const normalized = stripInternalIdentifiers(value)
    .replace(/\s+/gu, '')
    .toUpperCase();
  const building = /^(A|B|C|D|E|H)(?:楼)?$/u.exec(normalized);
  if (building) return `${building[1]}楼`;
  return /^110(?:站)?$/u.test(normalized) ? '110站' : '';
}

function stripInternalIdentifiers(value: unknown): string {
  return display(value)
    .replace(/(?:opt|ou_|rec)[A-Za-z0-9_-]{3,}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function formatHours(value: number): string {
  return Number.isFinite(value)
    ? Number(value.toFixed(2)).toString()
    : '未提供';
}

function display(value: unknown): string {
  const normalized = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || '未提供';
}

function escape(value: unknown): string {
  return display(value).replace(/[\\`*_{}\[\]<>!|~()]/gu, '\\$&');
}

function assertMultiShiftCardSize(
  card: Record<string, unknown>,
  groupCount: number,
): Record<string, unknown> {
  if (
    groupCount > 0 &&
    Buffer.byteLength(JSON.stringify(card), 'utf8') > CARD_MAX_BYTES
  ) {
    throw new Error(`飞书逐班次替班卡片超过 30 KB：班次数 ${groupCount}`);
  }
  return card;
}
