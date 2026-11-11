import type { ProfileChange } from '../../../shared/personnel-profile-change.interface';
import { readPublicApplicationUrl } from '../config/public-application-url';
export function profileChangeReviewUrl(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error('PROFILE_NOTIFICATION_ID_INVALID');
  const url = new URL(readPublicApplicationUrl([]));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('PROFILE_NOTIFICATION_URL_INVALID');
  url.pathname = url.pathname.replace(/\/$/, '') + '/system-configuration';
  url.searchParams.set('tab', 'profile-changes');
  url.searchParams.set('requestId', id);
  return url.toString();
}
export function profileChangeCard(
  row: ProfileChange,
  url: string,
  revoked = false,
): Record<string, unknown> {
  const status = revoked
    ? '接收权限已变更'
    : (
        {
          pending: '待审核',
          approved: '已批准，等待同步',
          uploading: '照片同步中',
          writing: '资料同步中',
          completed: '已更新',
          rejected: '已拒绝',
          cancelled: '已撤回',
          conflict: '资料已变化，待重新申请',
          reconciliation: '处理结果待核对',
        } as const
      )[row.status];
  const labels = { phone: '手机号', email: '邮箱', photo: '照片' };
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template:
        row.status === 'pending' && !revoked
          ? 'blue'
          : row.status === 'completed'
            ? 'green'
            : 'grey',
      title: { tag: 'plain_text', content: '个人资料变更 · ' + status },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `申请人：${row.applicantName}\n修改项目：${Object.keys(
            labels,
          )
            .filter((key) => Object.hasOwn(row.changes, key))
            .map((key) => labels[key as keyof typeof labels])
            .join('、')}\n状态：${status}`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: row.status === 'pending' && !revoked ? 'primary' : 'default',
            text: {
              tag: 'plain_text',
              content: revoked
                ? '已停止接收'
                : row.status === 'pending'
                  ? '前往审核'
                  : '查看申请',
            },
            ...(revoked ? { disabled: true } : { url }),
          },
        ],
      },
    ],
  };
}
