import type {
  ThresholdAdjustment,
  ThresholdApprovalRole,
} from '../../../shared/threshold-adjustment.interface';
import { THRESHOLD_ADJUSTMENT_LABELS } from '../../../shared/threshold-adjustment.interface';

const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_`[\]\\])/g, '\\$1');
const markdown = (label: string, value: string) => ({
  tag: 'markdown',
  content: `**${escape(label)}**\n${escape(value || '空白')}`,
});
export function thresholdAdjustmentCard(
  a: ThresholdAdjustment,
  openId: string,
  rejectingRole?: ThresholdApprovalRole,
  confirmationEnabled = false,
): Record<string, unknown> {
  const waiting = ['routing', 'pending'].includes(a.state);
  const stages = a.stages.filter((s) => s.approver.openId === openId);
  const elements: Record<string, unknown>[] = [
    markdown(
      '设备参数',
      `${a.before.building} · ${a.before.device}\n${a.before.parameter}${a.before.location ? ' · ' + a.before.location : ''}`,
    ),
    markdown(
      '阈值调整',
      `${a.before.value || '空白'} → ${a.value || '空白'}${a.before.unit ? ' ' + a.before.unit : ''}`,
    ),
    markdown('申请人 / 调整人', `${a.applicant.name} / ${a.engineer.name}`),
    markdown('调整原因', a.reason),
    markdown(
      '预计调整时间',
      new Date(a.plannedAt).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      }),
    ),
    markdown(
      '审批进度',
      a.stages
        .map(
          (s) =>
            `${s.role === 'building' ? '楼长' : '专业主管'} · ${s.approver.name}：${s.decision ? (s.decision.action === 'approve' ? '通过' : '驳回') : '待审批'}`,
        )
        .join('\n'),
    ),
  ];
  const rejection = a.stages.find(
    (s) => s.decision?.action === 'reject',
  )?.decision;
  if (rejection) elements.push(markdown('驳回原因', rejection.reason));
  if (a.error) elements.push(markdown('处理异常', a.error));
  if (a.execution?.replies.length)
    elements.push(
      markdown(
        '调整确认',
        a.execution.replies
          .map(
            (r) =>
              `${r.actor.name} · ${new Date(r.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}：${r.completed ? '已完成' : '尚未完成'}`,
          )
          .join('\n'),
      ),
    );
  if (
    confirmationEnabled &&
    openId === a.engineer.openId &&
    a.state === 'awaiting_completion'
  ) {
    elements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [button(a, 'engineer', 'complete', '已完成', false)],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [button(a, 'engineer', 'not_completed', '尚未完成', false)],
        },
      ],
    });
  }
  if (
    waiting &&
    rejectingRole &&
    stages.some((s) => s.role === rejectingRole && !s.decision)
  ) {
    elements.push(
      {
        tag: 'form',
        name: 'threshold_rejection_form',
        elements: [
          {
            tag: 'input',
            name: 'threshold_rejection_reason',
            required: true,
            input_type: 'multiline_text',
            max_length: 500,
            rows: 3,
            width: 'fill',
            label: { tag: 'plain_text', content: '驳回原因' },
          },
          {
            tag: 'button',
            name: `threshold_reject_submit:${a.id}:${rejectingRole}`,
            type: 'danger',
            width: 'fill',
            form_action_type: 'submit',
            text: { tag: 'plain_text', content: '确认驳回' },
          },
        ],
      },
      button(a, rejectingRole, 'return', '返回审批', false),
    );
  } else {
    for (const s of stages)
      elements.push({
        tag: 'column_set',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [
              button(
                a,
                s.role,
                'approve',
                `${stages.length > 1 ? (s.role === 'building' ? '楼长' : '专业主管') + ' · ' : ''}确认通过`,
                !waiting || !!s.decision,
              ),
            ],
          },
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [
              button(
                a,
                s.role,
                'open_reject',
                '驳回',
                !waiting || !!s.decision,
              ),
            ],
          },
        ],
      });
  }
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template:
        a.state === 'rejected'
          ? 'red'
          : a.state === 'completed'
            ? 'green'
            : 'blue',
      title: {
        tag: 'plain_text',
        content: rejectingRole
          ? '阈值调整 · 驳回原因'
          : `阈值调整 · ${THRESHOLD_ADJUSTMENT_LABELS[a.state]}`,
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements,
    },
  };
}
function button(
  a: ThresholdAdjustment,
  role: ThresholdApprovalRole | 'engineer',
  action: string,
  label: string,
  disabled: boolean,
) {
  return {
    tag: 'button',
    type: disabled
      ? 'default'
      : action === 'approve'
        ? 'primary_filled'
        : action === 'open_reject'
          ? 'danger'
          : 'default',
    width: 'fill',
    text: { tag: 'plain_text', content: label },
    ...(disabled
      ? { disabled: true }
      : {
          behaviors: [
            {
              type: 'callback',
              value: {
                workflowType: 'threshold_adjustment',
                requestId: a.id,
                role,
                action,
              },
            },
          ],
        }),
  };
}
export function parseThresholdAdjustmentAction(payload: unknown) {
  const event = payload as Record<string, unknown>,
    action = event?.action as Record<string, unknown>;
  const operator = event?.operator as { open_id?: unknown },
    context = event?.context as { open_message_id?: unknown };
  const match =
    typeof action?.name === 'string'
      ? /^threshold_reject_submit:(ta-[a-f0-9-]{36}):(building|professional)$/.exec(
          action.name,
        )
      : null;
  const value = action?.value as {
    workflowType?: string;
    requestId?: string;
    role?: string;
    action?: string;
  };
  const id = match?.[1] || value?.requestId,
    role = match?.[2] || value?.role;
  const decision = match ? 'reject' : value?.action;
  const form = action?.form_value as Record<string, unknown>;
  const reason =
    match && typeof form?.threshold_rejection_reason === 'string'
      ? form.threshold_rejection_reason.trim()
      : undefined;
  if (
    !event ||
    (event.event_type !== undefined &&
      event.event_type !== 'card.action.trigger') ||
    action?.tag !== 'button' ||
    !/^ta-[a-f0-9-]{36}$/.test(id || '') ||
    !['building', 'professional', 'engineer'].includes(role || '') ||
    ![
      'approve',
      'reject',
      'open_reject',
      'return',
      'complete',
      'not_completed',
    ].includes(decision || '') ||
    (!match && value?.workflowType !== 'threshold_adjustment') ||
    typeof operator?.open_id !== 'string' ||
    !/^ou_[A-Za-z0-9_-]+$/.test(operator.open_id) ||
    typeof context?.open_message_id !== 'string' ||
    !/^om_[A-Za-z0-9_-]+$/.test(context.open_message_id)
  )
    throw new Error('阈值审批卡片回调无效');
  if (
    (role === 'engineer') !==
    ['complete', 'not_completed'].includes(decision || '')
  )
    throw new Error('阈值卡片角色与动作不匹配');
  if (decision === 'reject' && (!match || !reason || reason.length > 500))
    throw new Error('请填写1–500字驳回原因');
  return {
    id: id!,
    role: role as ThresholdApprovalRole | 'engineer',
    action: decision as
      | 'approve'
      | 'reject'
      | 'open_reject'
      | 'return'
      | 'complete'
      | 'not_completed',
    reason,
    actorOpenId: operator.open_id,
    messageId: context.open_message_id,
  };
}
