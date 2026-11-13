import type { ProfileChange } from '../../../shared/personnel-profile-change.interface';
import { readPublicApplicationUrl } from '../config/public-application-url';

export function profileChangeReviewUrl(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('PROFILE_NOTIFICATION_ID_INVALID');
  const url = new URL(readPublicApplicationUrl([]));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('PROFILE_NOTIFICATION_URL_INVALID');
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/system-configuration';
  url.searchParams.set('tab', 'profile-changes');
  url.searchParams.set('requestId', id);
  return url.toString();
}

export interface ProfileCardPresentation {
  actionable?: boolean;
  beforeImageKey?: string;
  beforePhotoAbsent?: boolean;
  afterImageKey?: string;
}

type CardElement = Record<string, unknown>;
const plain = (content: string) => ({ tag: 'plain_text', content });
const detail = (content: string): CardElement => ({ tag: 'div', text: plain(content) });
const safeText = (value: unknown, max = 320) =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max)
    : '';
const imageKey = (value: unknown): value is string =>
  typeof value === 'string' && /^img(?:_v\d+)?_[A-Za-z0-9_-]{1,240}$/.test(value);

function reviewButton(row: ProfileChange, decision: 'approve' | 'reject'): CardElement {
  return {
    tag: 'button',
    type: decision === 'approve' ? 'primary' : 'danger',
    text: plain(decision === 'approve' ? '同意修改' : '驳回申请'),
    value: {
      workflowType: 'profile_change',
      action: 'profile_change_review',
      requestId: row.id,
      expectedVersion: row.version,
      decision,
    },
    confirm: {
      title: plain(decision === 'approve' ? '确认同意本次资料修改？' : '确认驳回本次申请？'),
      text: plain('请核对修改信息；驳回原因和审核人将记录到申请中。'),
    },
  };
}

/** Legacy card form: do not mix Card 2.0 form_action_type into this card schema. */
function rejectionForm(row: ProfileChange): CardElement {
  return {
    tag: 'form',
    name: 'profile_change_rejection',
    elements: [
      {
        tag: 'input',
        name: 'rejection_reason',
        required: true,
        input_type: 'multiline_text',
        max_length: 1000,
        label: plain('驳回原因'),
        placeholder: plain('仅驳回时填写，说明需要申请人修改的内容'),
      },
      {
        ...reviewButton(row, 'reject'),
        name: 'profile_change_reject',
        action_type: 'form_submit',
      },
    ],
  };
}

/**
 * Applicant-facing result card: sent after an administrator finishes the review.
 * Informational only — no action buttons, no callback, no navigation, so an
 * applicant can never re-trigger or alter the review from this card.
 */
export function profileChangeResultCard(
  row: ProfileChange,
): Record<string, unknown> {
  const config = { wide_screen_mode: true, update_multi: true };
  const approved = row.status === 'completed';
  const labels = { phone: '手机号', email: '邮箱', photo: '照片' };
  const changedFields = Object.keys(labels)
    .filter((key) => Object.hasOwn(row.changes, key))
    .map((key) => labels[key as keyof typeof labels])
    .join('、');
  const elements: CardElement[] = [
    detail(
      `审批结果：${approved ? '已通过，资料已更新' : '未通过'}\n修改项目：${changedFields || '无'}`,
    ),
  ];
  for (const key of ['phone', 'email'] as const) {
    if (Object.hasOwn(row.changes, key)) {
      elements.push(
        detail(
          `${labels[key]}\n修改前：${safeText(row.before?.[key]) || '未填写'}\n${approved ? '已更新为' : '申请修改为'}：${safeText(row.changes[key]) || '未填写'}`,
        ),
      );
    }
  }
  if (Object.hasOwn(row.changes, 'photo')) {
    elements.push(
      detail(`照片\n${approved ? '已更新为你提交的新照片' : '未通过，保持原照片'}`),
    );
  }
  if (row.reviewerName)
    elements.push(detail(`审核人：${safeText(row.reviewerName, 120)}`));
  if (row.comment)
    elements.push(detail(`管理员意见：${safeText(row.comment, 1000)}`));
  const finishedAt = resultTime(row.updatedAt);
  if (finishedAt) elements.push(detail(`处理时间：${finishedAt}`));
  return {
    config,
    header: {
      template: approved ? 'green' : 'red',
      title: plain('个人资料修改申请 · 审批结果'),
    },
    elements,
  };
}

function resultTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return safeText(value, 40);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(millis));
}

export function profileChangeCard(
  row: ProfileChange,
  url: string,
  revoked = false,
  presentation: ProfileCardPresentation = {},
): Record<string, unknown> {
  const config = { wide_screen_mode: true, update_multi: true };
  if (revoked) {
    return {
      config,
      header: { template: 'grey', title: plain('个人资料变更 · 接收权限已变更') },
      elements: [detail('此卡已停止提供申请资料和办理操作，请由当前有权管理员处理。')],
    };
  }
  const status = {
    pending: '待审核', approved: '已批准，等待同步', uploading: '照片同步中',
    writing: '资料同步中', completed: '已更新', rejected: '已拒绝', cancelled: '已撤回',
    conflict: '资料已变化，待重新申请', reconciliation: '处理结果待核对',
  }[row.status];
  const actionable = presentation.actionable === true && row.status === 'pending' &&
    Number.isSafeInteger(row.version) && row.version > 0 &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.id);
  const photoComparisonReady = !Object.hasOwn(row.changes, 'photo') ||
    (imageKey(presentation.afterImageKey) &&
      (imageKey(presentation.beforeImageKey) || presentation.beforePhotoAbsent === true));
  const labels = { phone: '手机号', email: '邮箱', photo: '照片' };
  const changedFields = Object.keys(labels)
    .filter(key => Object.hasOwn(row.changes, key))
    .map(key => labels[key as keyof typeof labels]).join('、');
  const elements: CardElement[] = [
    detail(`申请人：${safeText(row.applicantName, 120)}\n修改项目：${changedFields}\n状态：${status}`),
  ];
  for (const key of ['phone', 'email'] as const) {
    if (Object.hasOwn(row.changes, key)) {
      elements.push(detail(`${labels[key]}\n修改前：${safeText(row.before?.[key]) || '未填写'}\n申请修改为：${safeText(row.changes[key]) || '未填写'}`));
    }
  }
  if (Object.hasOwn(row.changes, 'photo')) {
    for (const [label, key] of [
      ['修改前照片', presentation.beforeImageKey],
      ['申请的新照片', presentation.afterImageKey],
    ] as const) {
      elements.push(detail(label));
      if (label === '修改前照片' && presentation.beforePhotoAbsent === true) {
        elements.push(detail('申请前暂无照片'));
      } else if (imageKey(key)) {
        elements.push({ tag: 'img', img_key: key, alt: plain(label), mode: 'fit_horizontal', preview: true });
      } else {
        elements.push(detail('图片暂不可用，前往平台核对。'));
      }
    }
  }
  if (row.reviewerName) elements.push(detail(`审核人：${safeText(row.reviewerName, 120)}`));
  if (row.comment) elements.push(detail(`审核说明：${safeText(row.comment, 1000)}`));

  const actions: CardElement[] = [];
  if (actionable && photoComparisonReady) actions.push(reviewButton(row, 'approve'));
  if (actionable && !photoComparisonReady) {
    elements.push(detail('照片对比尚不完整，请前往平台核对后同意修改；仍可填写原因后驳回。'));
  }
  if (row.status !== 'pending') {
    // Existing reviewers keep the same operation labels, with no callback or navigation.
    actions.push(...['同意修改', '驳回申请'].map(content => ({ tag: 'button', type: 'default', disabled: true, text: plain(content) })));
  }
  actions.push({
    tag: 'button', type: 'default', text: plain('平台查看申请'),
    ...(row.status === 'pending' ? { url } : { disabled: true }),
  });
  elements.push({ tag: 'action', actions });
  if (actionable) elements.push(rejectionForm(row));
  if (row.status === 'pending' && !actionable) {
    elements.push(detail('卡片审批暂不可用，请进入平台核对申请。'));
  }
  return {
    config,
    header: {
      template: row.status === 'pending' ? 'blue' : row.status === 'completed' ? 'green' : 'grey',
      title: plain('个人资料变更 · ' + status),
    },
    elements,
  };
}
