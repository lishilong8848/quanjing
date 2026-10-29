import { BUSINESS_ACTION_LABELS } from '@shared/business-permissions';
import type { RequestedPermission } from '@shared/personnel-permission-request.interface';
import type { PersonalPermissionCatalog } from '@/api/personal-access';

export function permissionRequestLabel(permission: RequestedPermission, catalog: PersonalPermissionCatalog): string {
  if (permission.kind === 'page') return `${catalog.pages.find(page => page.path === permission.path)?.label || '页面'} · 页面查看`;
  const page = catalog.pages.find(page => page.modules.some(module => module.id === permission.module));
  const module = page?.modules.find(module => module.id === permission.module);
  const range = module?.scoped ? ` · ${permission.buildings?.join('、') || '全部楼栋'} · ${permission.specialties?.join('、') || '全部专业'}` : '';
  return `${page?.label || '页面'} / ${module?.label || '功能'} · ${BUSINESS_ACTION_LABELS[permission.action]}${range}`;
}

export function addRequestedPermission(current: RequestedPermission[], next: RequestedPermission): RequestedPermission[] {
  if (current.some(item => JSON.stringify(item) === JSON.stringify(next))) return current;
  if (current.length >= 20) throw new Error('每次最多申请 20 项权限');
  return [...current, next];
}
