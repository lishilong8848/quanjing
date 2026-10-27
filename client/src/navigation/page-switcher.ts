import {
  BookOpen,
  Building2,
  Calendar,
  ClipboardCheck,
  ClipboardList,
  BellRing,
  FileBarChart2,
  FileText,
  Gauge,
  HardHat,
  History,
  MapPinned,
  Network,
  PanelsTopLeft,
  Route,
  ScanSearch,
  SlidersHorizontal,
  ShieldCheck,
  ShoppingCart,
  Users,
  Warehouse,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { AccessRole } from '@shared/access-control.interface';

import { canAccessPage } from '../access/access-policy';

export interface SwitcherPage {
  key: string;
  label: string;
  path: string;
  icon: LucideIcon;
  domainKey: NavigationDomainKey;
  description: string;
  external?: boolean;
  hiddenFromSwitcher?: boolean;
  aliases?: readonly string[];
}

export const NAVIGATION_DOMAINS = [
  {
    key: 'platform',
    label: '平台门户',
    description: '基地门户与平台能力总览',
  },
  {
    key: 'operations',
    label: '运营指挥',
    description: '当日重点与园区运行态势',
  },
  {
    key: 'people',
    label: '人员保障',
    description: '排班、组织、持证与培训',
  },
  {
    key: 'safety',
    label: '运维质量',
    description: '施工、风险与质量评估',
  },
  {
    key: 'equipment',
    label: '设备运维',
    description: '设备全周期、轮巡与定位',
  },
  {
    key: 'supply',
    label: '采‑供‑存',
    description: '采购、库存与合同协同',
  },
  {
    key: 'knowledge',
    label: '知识交付',
    description: '知识沉淀与报告交付',
  },
] as const;

export type NavigationDomainKey = (typeof NAVIGATION_DOMAINS)[number]['key'];

export interface AccessibleNavigationDomain {
  key: NavigationDomainKey;
  label: string;
  description: string;
  pages: readonly SwitcherPage[];
}

export const PAGE_REGISTRY: readonly SwitcherPage[] = [
  {
    key: 'nantong-base',
    label: '基地门户',
    path: '/nantong-base',
    icon: Building2,
    domainKey: 'platform',
    description: '南通基地信息与运营入口总览',
  },
  {
    key: 'operations-architecture',
    label: '业务架构',
    path: '/operations-architecture',
    icon: Network,
    domainKey: 'platform',
    description: '查看平台业务能力与协同关系',
  },
  {
    key: 'today-focus',
    label: '今日重点',
    path: '/today-focus-checklist',
    icon: ClipboardList,
    domainKey: 'operations',
    description: '聚合当日待办、重点和跟进事项',
    hiddenFromSwitcher: true,
    aliases: ['/schedule-calendar'],
  },
  {
    key: 'today-operations-panorama',
    label: '今日航图',
    path: '/today-operations-panorama',
    icon: PanelsTopLeft,
    domainKey: 'operations',
    description: '总览今日运行状态与关键事件',
  },
  {
    key: 'monthly-operations',
    label: '智舱月览',
    path: '/monthly-operations',
    icon: FileBarChart2,
    domainKey: 'operations',
    description: '查看月度容量、能效与运营执行趋势',
  },
  {
    key: 'operations-dashboard',
    label: '主变运行',
    path: '/campus-operations-dashboard',
    icon: Gauge,
    domainKey: 'operations',
    description: '查看主变与园区运行指标',
  },
  {
    key: 'schedule',
    label: '排班中心',
    path: '/monthly-schedule',
    icon: Calendar,
    domainKey: 'people',
    description: '查看和管理楼栋值班安排',
  },
  {
    key: 'organization',
    label: '组织架构',
    path: '/organization',
    icon: Users,
    domainKey: 'people',
    description: '查看组织、岗位与人员关系',
  },
  {
    key: 'training-certification',
    label: '培训持证',
    path: '/training-certification-management',
    icon: ShieldCheck,
    domainKey: 'people',
    description: '统筹培训进度、证书合规与到期风险',
  },
  {
    key: 'construction',
    label: '施工管理',
    path: '/construction-management',
    icon: HardHat,
    domainKey: 'safety',
    description: '管理施工项目、许可与现场过程',
  },
  {
    key: 'risk-dashboard',
    label: '风险排查',
    path: '/risk-inspection-dashboard',
    icon: ScanSearch,
    domainKey: 'safety',
    description: '跟踪风险发现、整改与闭环',
  },
  {
    key: 'quality-assessment',
    label: '质量评估',
    path: '/quality-assessment',
    icon: ClipboardCheck,
    domainKey: 'safety',
    description: '查看月度楼栋评级、标杆与质量问题依据',
  },
  {
    key: 'monthly-alarm-overview',
    label: '月度告警总览',
    path: '/monthly-alarm-overview',
    icon: BellRing,
    domainKey: 'safety',
    description: '查看楼栋告警恢复、预期外分析与异常闭环',
  },
  {
    key: 'twin-graph',
    label: '孪生图谱',
    path: 'https://www.sm.sjhl.online:8787/',
    icon: Network,
    domainKey: 'equipment',
    description: '打开设备孪生图谱平台',
    external: true,
  },
  {
    key: 'equipment-lifecycle-dashboard',
    label: '设备生命周期',
    path: '/equipment-lifecycle-dashboard',
    icon: History,
    domainKey: 'equipment',
    description: '掌握设备状态与生命周期节点',
    hiddenFromSwitcher: true,
  },
  {
    key: 'equipment-ledger-management',
    label: '设备台账管理',
    path: '/equipment-ledger-management',
    icon: History,
    domainKey: 'equipment',
    description: '设备台账与维保状态',
  },
  {
    key: 'threshold-management',
    label: '阈值管理',
    path: '/threshold-management',
    icon: SlidersHorizontal,
    domainKey: 'equipment',
    description: '园区设备阈值与参数管理',
  },
  {
    key: 'equipment-dashboard',
    label: '设备轮巡',
    path: '/equipment-patrol-dashboard',
    icon: Route,
    domainKey: 'equipment',
    description: '查看设备巡检路线与执行情况',
  },
  {
    key: 'exhaust-valve-map',
    label: '设备定位',
    path: '/exhaust-valve-map',
    icon: MapPinned,
    domainKey: 'equipment',
    description: '快速定位设备与关键设施',
  },
  {
    key: 'purchase',
    label: '采购管理',
    path: '/purchase-inventory-management',
    icon: ShoppingCart,
    domainKey: 'supply',
    description: '管理采购申请、订单和到货',
  },
  {
    key: 'inventory',
    label: '库存管理',
    path: '/inventory-management',
    icon: Warehouse,
    domainKey: 'supply',
    description: '管理库存、入库、出库与调拨',
  },
  {
    key: 'operations-tools',
    label: '运维工具管理',
    path: '/operations-tools-management',
    icon: Wrench,
    domainKey: 'supply',
    description: '工具台账、维护、送检与借还处置',
  },
  {
    key: 'contract',
    label: '合同管理',
    path: '/contract-management',
    icon: FileText,
    domainKey: 'supply',
    description: '跟踪合同、付款与履约情况',
  },
  {
    key: 'operations-kb',
    label: '运维知识库',
    path: '/operations-kb',
    icon: BookOpen,
    domainKey: 'knowledge',
    description: '检索运维资料、案例与标准',
  },
  {
    key: 'meeting-management',
    label: '议事航迹',
    path: '/meeting-management',
    icon: Calendar,
    domainKey: 'knowledge',
    description: '回溯历史会议、纪要与属地周报',
  },
  {
    key: 'system-monthly-report',
    label: '体系月报',
    path: '/system-monthly-report',
    icon: ClipboardList,
    domainKey: 'knowledge',
    description: '提交体系月报、跟踪分轮审核进度与查看审核排班',
  },
  {
    key: 'ali-monthly-report',
    label: '月度报告',
    path: '/ali-monthly-report',
    icon: FileBarChart2,
    domainKey: 'knowledge',
    description: '生成和交付月度运营报告',
  },
];

export function getAccessibleSwitcherPages(
  role: AccessRole,
  pagePaths?: readonly string[],
): readonly SwitcherPage[] {
  return PAGE_REGISTRY.filter(
    (page) => !page.hiddenFromSwitcher && canAccessPage(role, page.path, pagePaths),
  );
}

export function getAccessibleNavigationDomains(
  role: AccessRole,
  pagePaths?: readonly string[],
): readonly AccessibleNavigationDomain[] {
  const pages = getAccessibleSwitcherPages(role, pagePaths);

  return NAVIGATION_DOMAINS.map((domain) => ({
    ...domain,
    pages: pages.filter((page) => page.domainKey === domain.key),
  })).filter((domain) => domain.pages.length > 0);
}

function normalizeNavigationPath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0]?.trim().toLowerCase() || '/';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash || '/';
}

export function findNavigationPage(pathname: string): SwitcherPage | undefined {
  const normalizedPath = normalizeNavigationPath(pathname);

  return PAGE_REGISTRY.find((page) => {
    const pagePath = normalizeNavigationPath(page.path);
    if (
      normalizedPath === pagePath ||
      normalizedPath.startsWith(`${pagePath}/`)
    ) {
      return true;
    }

    return page.aliases?.some(
      (alias) => normalizeNavigationPath(alias) === normalizedPath,
    );
  });
}

export function getNavigationBrowserTitle(
  pathname: string,
): string | undefined {
  const page = findNavigationPage(pathname);
  if (!page) return undefined;

  const domain = NAVIGATION_DOMAINS.find(
    (candidate) => candidate.key === page.domainKey,
  );
  if (!domain) return undefined;

  return `南通全景运维平台 · ${domain.label} · ${page.label}`;
}
