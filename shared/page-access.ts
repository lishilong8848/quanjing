import type { AccessRole } from './access-control.interface';

export const PAGE_ACCESS_ROLES = ['guest', 'site_member', 'editor', 'admin', 'inventory_admin', 'building_admin', 'purchase_admin', 'purchase_applicant', 'duty_editor', 'supply_chain_admin', 'professional_admin', 'professional_engineer', 'construction_admin'] as const satisfies readonly AccessRole[];
export type RolePageRules = Partial<Record<AccessRole, string[]>>;
export const PAGE_ACCESS_CATALOG = [
  {
    "path": "/nantong-base",
    "label": "基地门户",
    "group": "platform"
  },
  {
    "path": "/operations-architecture",
    "label": "业务架构",
    "group": "platform"
  },
  {
    "path": "/today-focus-checklist",
    "label": "今日重点",
    "group": "operations"
  },
  {
    "path": "/today-operations-panorama",
    "label": "今日航图",
    "group": "operations"
  },
  {
    "path": "/monthly-operations",
    "label": "智舱月览",
    "group": "operations"
  },
  {
    "path": "/campus-operations-dashboard",
    "label": "主变运行",
    "group": "operations"
  },
  {
    "path": "/monthly-schedule",
    "label": "排班中心",
    "group": "people"
  },
  {
    "path": "/organization",
    "label": "组织架构",
    "group": "people"
  },
  {
    "path": "/training-certification-management",
    "label": "培训持证",
    "group": "people"
  },
  {
    "path": "/construction-management",
    "label": "施工管理",
    "group": "safety"
  },
  {
    "path": "/risk-inspection-dashboard",
    "label": "风险排查",
    "group": "safety"
  },
  {
    "path": "/quality-assessment",
    "label": "质量评估",
    "group": "safety"
  },
  {
    "path": "/monthly-alarm-overview",
    "label": "月度告警总览",
    "group": "safety"
  },
  {
    "path": "https://example.com:8787/",
    "label": "孪生图谱",
    "group": "equipment"
  },
  {
    "path": "/equipment-lifecycle-dashboard",
    "label": "设备生命周期",
    "group": "equipment"
  },
  {
    "path": "/equipment-ledger-management",
    "label": "设备台账管理",
    "group": "equipment"
  },
  {
    "path": "/threshold-management",
    "label": "阈值管理",
    "group": "equipment"
  },
  {
    "path": "/equipment-patrol-dashboard",
    "label": "设备轮巡",
    "group": "equipment"
  },
  {
    "path": "/exhaust-valve-map",
    "label": "设备定位",
    "group": "equipment"
  },
  {
    "path": "/purchase-inventory-management",
    "label": "采购管理",
    "group": "supply"
  },
  {
    "path": "/inventory-management",
    "label": "库存管理",
    "group": "supply"
  },
  {
    "path": "/operations-tools-management",
    "label": "运维工具管理",
    "group": "supply"
  },
  {
    "path": "/contract-management",
    "label": "合同管理",
    "group": "supply"
  },
  {
    "path": "/operations-kb",
    "label": "运维知识库",
    "group": "knowledge"
  },
  {
    "path": "/meeting-management",
    "label": "议事航迹",
    "group": "knowledge"
  },
  {
    "path": "/system-monthly-report",
    "label": "体系月报",
    "group": "knowledge"
  },
  {
    "path": "/ali-monthly-report",
    "label": "月度报告",
    "group": "knowledge"
  },
  {
    "path": "/mbti-assessment",
    "label": "性格测评",
    "group": "people"
  }
] as const;
const knownPages = new Set<string>(PAGE_ACCESS_CATALOG.map(page => page.path));
export function validPagePaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= knownPages.size && value.every(path => typeof path === 'string' && knownPages.has(path)) && new Set(value).size === value.length;
}
export function validRolePageRules(value: unknown): value is RolePageRules {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([role, paths]) => role !== 'admin' && (PAGE_ACCESS_ROLES as readonly string[]).includes(role) && validPagePaths(paths));
}
function normalizePagePath(path: string): string { return String(path || '/').split(/[?#]/, 1)[0].toLowerCase().replace(/\/+$/, '') || '/'; }
const PURCHASE_INVENTORY_MANAGEMENT_PATH = '/purchase-inventory-management';
function isPurchaseApplicationDirectPath(path: string): boolean { return path === '/purchase-inventory-management/apply/new'; }
const PROFESSIONAL_PAGES = new Set(['/operations-kb', '/meeting-management', '/system-monthly-report', '/ali-monthly-report', '/risk-inspection-dashboard', '/quality-assessment', '/monthly-alarm-overview', '/equipment-lifecycle-dashboard', '/equipment-ledger-management', '/threshold-management', '/equipment-patrol-dashboard', '/exhaust-valve-map', '/purchase-inventory-management', '/inventory-management', '/operations-tools-management', '/contract-management']);
const GUEST_PAGES = new Set([
  '/monthly-schedule',
  '/mbti-assessment',
  '/monthly-schedule/apply/leave',
  '/monthly-schedule/apply/overtime',
  '/today-operations-panorama',
  '/monthly-operations',
  '/nantong-base',
  '/system-monthly-report',
]);
const MONTHLY_SCHEDULE_PAGE = '/monthly-schedule';
const CONSTRUCTION_MANAGEMENT_PAGE = '/construction-management';
const CONTRACT_MANAGEMENT_PAGE = '/contract-management';
const INVENTORY_MANAGEMENT_PAGE = '/inventory-management';
const OPERATIONS_TOOLS_PAGE = '/operations-tools-management';
const CAMPUS_OPERATIONS_DASHBOARD_PAGE = '/campus-operations-dashboard';
export function defaultCanAccessPage(role: AccessRole, pathname: string): boolean {
  if (role === 'site_member') return ['/monthly-schedule', '/today-operations-panorama'].some(page => normalizePagePath(pathname) === page || normalizePagePath(pathname).startsWith(`${page}/`)) || defaultCanAccessPage('guest', pathname);
  if (role === 'admin') return true;
  const normalizedPathname = normalizePagePath(pathname);
  if (role === 'guest' && normalizedPathname.startsWith('/monthly-schedule/')) return false;
  if (role === 'guest' && ['/today-operations-panorama', '/monthly-operations', '/operations-kb', '/meeting-management', '/system-monthly-report', '/ali-monthly-report'].some(path => normalizedPathname === path || normalizedPathname.startsWith(`${path}/`))) return false;
  if (normalizedPathname === '/system-configuration' || normalizedPathname.startsWith('/system-configuration/')) return false;
  if (role === 'professional_admin' || role === 'professional_engineer') return GUEST_PAGES.has(normalizedPathname) || [...PROFESSIONAL_PAGES].some(path => normalizedPathname === path || normalizedPathname.startsWith(`${path}/`));
  if (normalizedPathname === CONSTRUCTION_MANAGEMENT_PAGE) return role !== 'guest';
  const isGuestPage = GUEST_PAGES.has(normalizedPathname);
  const isPurchasePage =
    normalizedPathname === PURCHASE_INVENTORY_MANAGEMENT_PATH ||
    isPurchaseApplicationDirectPath(normalizedPathname);
  if (role === 'editor') {
    return !(
      normalizedPathname === CONTRACT_MANAGEMENT_PAGE ||
      normalizedPathname.startsWith(`${CONTRACT_MANAGEMENT_PAGE}/`)
    );
  }
  if (role === 'inventory_admin') {
    return isGuestPage || normalizedPathname === INVENTORY_MANAGEMENT_PAGE || normalizedPathname === OPERATIONS_TOOLS_PAGE;
  }
  if (role === 'building_admin') {
    return (
      isGuestPage ||
      normalizedPathname === INVENTORY_MANAGEMENT_PAGE ||
      normalizedPathname === OPERATIONS_TOOLS_PAGE ||
      normalizedPathname === '/equipment-ledger-management' ||
      normalizedPathname === '/equipment-lifecycle-dashboard' ||
      isPurchasePage ||
      normalizedPathname === '/training-certification-management' ||
      normalizedPathname === '/risk-inspection-dashboard' ||
      normalizedPathname === '/quality-assessment' ||
      normalizedPathname === '/monthly-alarm-overview'
    );
  }
  if (role === 'purchase_admin') {
    return (
      isGuestPage ||
      isPurchasePage ||
      normalizedPathname === CONTRACT_MANAGEMENT_PAGE ||
      normalizedPathname.startsWith(`${CONTRACT_MANAGEMENT_PAGE}/`)
    );
  }
  if (role === 'purchase_applicant') {
    return isGuestPage || isPurchasePage;
  }
  if (role === 'duty_editor') {
    return isGuestPage;
  }
  if (role === 'supply_chain_admin') {
    return (
      isGuestPage ||
      isPurchasePage ||
      normalizedPathname === CONTRACT_MANAGEMENT_PAGE ||
      normalizedPathname.startsWith(`${CONTRACT_MANAGEMENT_PAGE}/`)
    );
  }
  if (role === 'construction_admin') {
    return isGuestPage;
  }
  return isGuestPage;
}


export function effectivePagePaths(role: AccessRole, rules?: RolePageRules): string[] {
  if (role === 'site_member' && rules?.site_member === undefined) return [...new Set([...effectivePagePaths('guest', rules), '/monthly-schedule', '/today-operations-panorama'])];
  return role === 'admin' ? [...knownPages] : [...(rules?.[role] ?? PAGE_ACCESS_CATALOG.filter(page => defaultCanAccessPage(role, page.path)).map(page => page.path))];
}
export function validPersonalPagePaths(role: AccessRole, paths: unknown): paths is string[] {
  return validPagePaths(paths) && (role === 'admin' || !paths.some(path=>path === '/system-configuration' || path.startsWith('/system-configuration/')));
}
export function effectiveAccountPagePaths(role: AccessRole, rules?: RolePageRules, paths?: readonly string[]): string[] {
  const defaults=effectivePagePaths(role,rules);
  if (paths === undefined || role === 'admin') return defaults;
  if (!validPersonalPagePaths(role,paths)) throw new Error('个人页面读取权限无效');
  return [...new Set([...defaults,...paths])];
}
export function canReadPage(role: AccessRole, path: string, paths?: readonly string[]): boolean {
  if (role === 'admin') return true;
  let normalized = normalizePagePath(path);
  if (normalized === '/campus-certificate-dashboard' || normalized === '/campus-training-dashboard') {
    normalized = '/training-certification-management';
  }
  if (role === 'guest' && normalized.startsWith('/monthly-schedule/')) return false;
  if (normalized === '/system-configuration' || normalized.startsWith('/system-configuration/')) return false;
  if (paths === undefined) return defaultCanAccessPage(role, normalized);
  const alias = normalized === '/schedule-calendar' ? '/today-focus-checklist' : normalized;
  return paths.some(page => knownPages.has(page) && (alias === normalizePagePath(page) || alias.startsWith(`${normalizePagePath(page)}/`)));
}

// Bind only observed page data routes; command/task/admin endpoints are not read grants.
const API_PAGES: readonly [RegExp, readonly string[], boolean][] = [
  [/^\/api\/(?:today-focus-checklist|sealing-info|change-info)(?:\/|$)/, ['/today-focus-checklist', '/today-operations-panorama', '/monthly-schedule'], true],
  [/^\/api\/bitable\/(?:non-duty-schedules|holiday-schedules|festival-schedules|today-leave-staff|schedule-snapshot-revision)(?:\/|$)/, ['/monthly-schedule', '/today-operations-panorama'], true],
  [/^\/api\/monthly-schedules(?:\/|$)/, ['/monthly-schedule'], true],
  [/^\/api\/duty-schedules$/, ['/monthly-schedule', '/today-operations-panorama'], true],
  [/^\/api\/duty-schedules\/(?:long-white-duty-staff|travel-staff|work-calendar|emergency-duty|exception-follow-ups)(?:\/|$)/, ['/monthly-schedule', '/today-operations-panorama'], true],
  [/^\/api\/bitable\/(?:today-operations-(?:alarms|overview|kpis)|alarm-human-reviews)(?:\/|$)/, ['/today-operations-panorama'], true],
  [/^\/api\/bitable\/monthly-operations-[a-z-]+(?:\/|$)/, ['/monthly-operations'], true],
  [/^\/api\/attendance(?:\/|$)/, ['/monthly-schedule', '/today-operations-panorama'], false],
  [/^\/api\/meeting-management\/(?:snapshot|records\/[^/]+|weekly\/(?:workspace|records\/[^/]+))$/, ['/meeting-management'], true],
  [/^\/api\/meeting-management(?:\/|$)/, ['/meeting-management'], false],
  [/^\/api\/operations-kb\/(?:stats|search|documents\/[^/]+)$/, ['/operations-kb'], true],
  [/^\/api\/operations-kb(?:\/|$)/, ['/operations-kb'], false],
  [/^\/api\/system-monthly-report\/(?:dashboard|archives\/[^/]+\/(?:download-url|preview))$/, ['/system-monthly-report'], true],
  [/^\/api\/system-monthly-report(?:\/|$)/, ['/system-monthly-report'], false],
  [/^\/api\/ali-monthly-report\/config$/, ['/ali-monthly-report'], true],
  [/^\/api\/ali-monthly-report(?:\/|$)/, ['/ali-monthly-report'], false],
  [/^\/api\/contract-management\/(?:dashboard|attachments\/[^/]+\/(?:manifest|download|pages\/\d+))$/, ['/contract-management'], true],
  [/^\/api\/contract-management(?:\/|$)/, ['/contract-management'], false],
  [/^\/api\/purchase-inventory\/dashboard$/, ['/purchase-inventory-management'], true],
  [/^\/api\/purchase-inventory(?:\/|$)/, ['/purchase-inventory-management'], false],
  [/^\/api\/inventory-management\/(?:dashboard|items|movements|storage-locations|stocktake\/(?:overview|sheet))$/, ['/inventory-management'], true],
  [/^\/api\/inventory-management(?:\/|$)/, ['/inventory-management'], false],
  [/^\/api\/operations-tools\/snapshot$/, ['/operations-tools-management'], true],
  [/^\/api\/operations-tools(?:\/|$)/, ['/operations-tools-management'], false],
  [/^\/api\/equipment-ledger(?:\/|$)/, ['/equipment-ledger-management'], true],
  [/^\/api\/equipment-lifecycle\/dashboard$/, ['/equipment-lifecycle-dashboard', '/equipment-ledger-management'], true],
  [/^\/api\/equipment-patrol(?:\/|$)/, ['/equipment-patrol-dashboard'], true],
  [/^\/api\/threshold-management\/(?:records|adjustments|sync\/source)$/, ['/threshold-management'], true],
  [/^\/api\/threshold-management(?:\/|$)/, ['/threshold-management'], false],
  [/^\/api\/risk-inspection\/monthly-alarm-overview(?:\/|$)/, ['/monthly-alarm-overview'], true],
  [/^\/api\/risk-inspection\/ali-monthly-quality(?:\/|$)/, ['/quality-assessment', '/risk-inspection-dashboard'], true],
  [/^\/api\/risk-inspection(?:\/|$)/, ['/risk-inspection-dashboard'], true],
  [/^\/api\/bitable\/campus-operations-dashboard$/, ['/campus-operations-dashboard'], true],
  [/^\/api\/bitable\/campus-(?:training|certificate)-dashboard$/, ['/training-certification-management'], true],
  [/^\/api\/bitable\/(?:organizations|organization-person-profile)(?:\/|$)/, ['/organization'], true],
  [/^\/api\/duty-schedules\/construction-management(?:\/|$)/, ['/construction-management'], true],
];
export function pageApiBinding(path: string): { pages: readonly string[]; readable: boolean } | undefined {
  const match = API_PAGES.find(([pattern]) => pattern.test(path));
  return match ? { pages: match[1], readable: match[2] } : undefined;
}
