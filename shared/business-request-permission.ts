import type { BusinessPermissionContext } from './business-permissions';
import { PERMISSION_ROUTE_CLASSIFICATIONS, type PermissionRouteDefinition } from './permission-route-classification';

export interface BusinessRequestClassification {
  kind: PermissionRouteDefinition['kind'];
  declared: boolean;
  route?: PermissionRouteDefinition;
  /** Compatibility primary permission; use permissions for complete request checks. */
  permission?: BusinessPermissionContext;
  /** All fixed requirements, including read/create plus an explicit refresh request. */
  permissions?: readonly BusinessPermissionContext[];
  /** Entry only: the named service must authorize the actual existing-record branch. */
  candidatePermissions?: readonly BusinessPermissionContext[];
  reason?: string;
}

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = PERMISSION_ROUTE_CLASSIFICATIONS.filter(route => route.path !== '/*').slice().sort((left, right) =>
  left.path.split('/').filter(segment => segment.startsWith(':')).length - right.path.split('/').filter(segment => segment.startsWith(':')).length ||
  right.path.split('/').length - left.path.split('/').length).map(route => ({ route,
  pattern: new RegExp(`^${route.path.split('/').map(segment => {
    if (segment === ':year') return '\\d{4}';
    if (segment === ':month') return '(?:0?[1-9]|1[0-2])';
    if (segment === ':index' || segment === ':page') return '(?:0|[1-9]\\d*)';
    return segment.startsWith(':') ? '[^/\\\\?#\\x00-\\x20\\x7f]{1,512}' : escapePattern(segment);
  }).join('/')}$`, 'u') }));

function parseTarget(target: string): { path: string; query: URLSearchParams } | undefined {
  if (typeof target !== 'string' || target.length > 8192 || /[\u0000-\u001f\u007f\\]/u.test(target)) return undefined;
  const absolute = /^https?:\/\/[^/?#]+(\/[^#]*)?$/iu.exec(target);
  const relative = absolute ? absolute[1] || '/' : target;
  if (!relative.startsWith('/') || relative.includes('#')) return undefined;
  const separator = relative.indexOf('?');
  let pathname = separator < 0 ? relative : relative.slice(0, separator);
  try {
    for (let depth = 0; depth < 3; depth++) {
      if (/%(?:2f|5c)/iu.test(pathname)) return undefined;
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
  } catch { return undefined; }
  if (/%|[\u0000-\u0020\u007f\\?#]/u.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) return undefined;
  pathname = pathname.replace(/\/+$/u, '') || '/';
  if (pathname.includes('//')) return undefined;
  return { path: pathname, query: new URLSearchParams(separator < 0 ? '' : relative.slice(separator + 1)) };
}

export function classifyBusinessRequest(target: string, method: string, force = false): BusinessRequestClassification {
  const parsed = parseTarget(target);
  if (!parsed || typeof method !== 'string') return { kind: 'denied', declared: false, reason: 'invalid-request-target' };
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const definition = compiled.find(({ route, pattern }) => route.method === verb && pattern.test(parsed.path))?.route;
  const route = definition || (verb === 'GET' && !/^\/(?:api|callbacks)(?:\/|$)/iu.test(parsed.path)
    ? PERMISSION_ROUTE_CLASSIFICATIONS.find(item => item.path === '/*') : undefined);
  if (!route) return { kind: 'denied', declared: false, reason: 'undeclared-route' };
  if (route.kind === 'auxiliary' && route.refreshPermission && route.refreshQueries?.length && (force ||
    route.refreshQueries.some(key => parsed.query.getAll(key).some(value => !['', '0', 'false'].includes(value.trim().toLowerCase()))))) {
    return { kind: 'business', declared: true, route, permission: route.refreshPermission, permissions: [route.refreshPermission] };
  }
  if (route.kind !== 'business') return { kind: route.kind, declared: true, route };
  if (!route.permission) return { kind: 'denied', declared: true, route, reason: 'missing-business-permission' };
  const original = { ...route.permission };
  if (route.selectorPermissions) {
    return { kind: 'business', declared: true, route, permission: original, permissions: [], candidatePermissions: route.selectorPermissions };
  }
  if(route.selectorActions){
    const refreshing=verb==='GET' && !!route.refreshQueries?.length && (force || route.refreshQueries.some(key=>parsed.query.getAll(key).some(value=>!['','0','false'].includes(value.trim().toLowerCase()))));
    return {kind:'business',declared:true,route,permission:original,permissions:refreshing?[{module:original.module,action:'refresh'}]:[],candidatePermissions:route.selectorActions.map(action=>({module:original.module,action}))};
  }
  if (route.recordDependent) return { kind: 'business', declared: true, route, permission: original, permissions: [],
    candidatePermissions: route.recordDependent.candidateActions.map(action => ({ module: original.module, action })) };
  const refreshing = verb === 'GET' && original.action !== 'export' && !!route.refreshQueries?.length && (force ||
    route.refreshQueries.some(key => parsed.query.getAll(key).some(value => !['', '0', 'false',...(route.passiveRefreshValues||[])].includes(value.trim().toLowerCase()))));
  if (!refreshing) return { kind: 'business', declared: true, route, permission: original, permissions: [original] };
  const refresh: BusinessPermissionContext = { module: original.module, action: 'refresh' };
  const permissions = original.action === 'refresh' ? [original] : [original, refresh];
  return { kind: 'business', declared: true, route, permission: original.action === 'read' ? refresh : original, permissions };
}

export function businessRequestPermission(path: string, method: string, force = false): BusinessPermissionContext | undefined {
  return classifyBusinessRequest(path, method, force).permission;
}
