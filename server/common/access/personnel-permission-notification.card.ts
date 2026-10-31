import { BUSINESS_ACTION_LABELS, businessModuleDefinition } from '../../../shared/business-permissions';
import { createPermissionCatalog } from '../../../shared/permission-catalog';
import type { PersonnelPermissionRequest, RequestedPermission } from '../../../shared/personnel-permission-request.interface';
import { readPublicApplicationUrl } from '../config/public-application-url';

export function permissionRequestReviewUrl(requestId: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(requestId)) throw new Error('PERMISSION_NOTIFICATION_ID_INVALID');
  const base = readPublicApplicationUrl([]), url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('PERMISSION_NOTIFICATION_URL_INVALID');
  url.pathname = url.pathname.replace(/\/$/u, '') + '/system-configuration';
  url.searchParams.set('tab', 'permission-requests'); url.searchParams.set('requestId', requestId);
  return url.toString();
}
export function requestedPermissionText(item: RequestedPermission): string {
  const catalog = createPermissionCatalog();
  if (item.kind === 'page') return `页面查看：${catalog.pages.find(page => page.path === item.path)?.label || item.path}`;
  const module = businessModuleDefinition(item.module);
  return `${catalog.pages.find(page => page.path === module.page)?.label || module.page} · ${module.label} · ${BUSINESS_ACTION_LABELS[item.action]}` +
    (module.scoped ? `\n楼栋：${item.buildings?.join('、') || '全部'}；专业：${item.specialties?.join('、') || '全部'}` : '');
}
export function permissionRequestNotificationCard(request: PersonnelPermissionRequest, url: string): Record<string, unknown> {
  const status = { pending: '待审批', approved: '已授权', rejected: '已驳回', cancelled: '已撤回' }[request.status];
  const text = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } });
  const elements: Record<string, unknown>[] = [text(`申请人：${request.applicantName}\n状态：${status}`),
    text(request.permissions.map((item, index) => `${index + 1}. ${requestedPermissionText(item)}`).join('\n\n')),
    text(`申请理由：${request.reason}`)];
  if (request.reviewerName) elements.push(text(`处理人：${request.reviewerName}${request.comment ? '\n审核说明：' + request.comment : ''}`));
  elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: request.status === 'pending' ? '前往审批' : status },
    type: request.status === 'pending' ? 'primary' : 'default', ...(request.status === 'pending' ? { url } : { disabled: true }) }] });
  return { config: { wide_screen_mode: true, update_multi: true }, header: { template: request.status === 'pending' ? 'blue' : request.status === 'approved' ? 'green' : 'grey',
    title: { tag: 'plain_text', content: '个人权限申请 · ' + status } }, elements };
}
