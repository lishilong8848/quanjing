import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NAVIGATION_DOMAINS,
  PAGE_REGISTRY,
  findNavigationPage,
  getAccessibleNavigationDomains,
  getAccessibleSwitcherPages,
  getNavigationBrowserTitle,
} from '../../client/src/navigation/page-switcher';

const EXPECTED_DOMAIN_LABELS = [
  '平台门户',
  '运营指挥',
  '人员保障',
  '运维质量',
  '设备运维',
  '采‑供‑存',
  '知识交付',
] as const;

const EXPECTED_ADMIN_PATHS = [
  '/nantong-base',
  '/operations-architecture',
  '/today-focus-checklist',
  '/today-operations-panorama',
  '/monthly-operations',
  '/campus-operations-dashboard',
  '/monthly-schedule',
  '/organization',
  '/training-certification-management',
  '/construction-management',
  '/risk-inspection-dashboard',
  '/quality-assessment',
  '/monthly-alarm-overview',
  'https://www.sm.sjhl.online:8787/',
  '/equipment-lifecycle-dashboard',
  '/equipment-ledger-management',
  '/threshold-management',
  '/equipment-patrol-dashboard',
  '/exhaust-valve-map',
  '/purchase-inventory-management',
  '/inventory-management',
  '/operations-tools-management',
  '/contract-management',
  '/operations-kb',
  '/meeting-management',
  '/system-monthly-report',
  '/ali-monthly-report',
] as const;

const EXPECTED_ADMIN_SWITCHER_PATHS = EXPECTED_ADMIN_PATHS.filter(
  (path) =>
    path !== '/today-focus-checklist' &&
    path !== '/equipment-lifecycle-dashboard',
);

function readSource(path: string): string {
  return readFileSync(resolve(__dirname, '../..', path), 'utf8');
}

describe('global page navigation directory', () => {
  it('keeps desktop domain popovers focused on application entries', () => {
    const source = readSource('client/src/components/GlobalNavigation.tsx');

    expect(source).toContain('showDomainHeader = true');
    expect(source).toContain('showDomainHeader={false}');
    expect(source).toContain('`${domain.label}应用入口`');
  });

  it('keeps the approved seven domains and registered pages in one deterministic order', () => {
    expect(NAVIGATION_DOMAINS.map((domain) => domain.label)).toEqual(
      EXPECTED_DOMAIN_LABELS,
    );
    expect(PAGE_REGISTRY).toHaveLength(EXPECTED_ADMIN_PATHS.length);
    expect(PAGE_REGISTRY.map((page) => page.path)).toEqual(
      EXPECTED_ADMIN_PATHS,
    );
    expect(new Set(PAGE_REGISTRY.map((page) => page.path)).size).toBe(
      EXPECTED_ADMIN_PATHS.length,
    );
    expect(
      PAGE_REGISTRY.every((page) =>
        NAVIGATION_DOMAINS.some((domain) => domain.key === page.domainKey),
      ),
    ).toBe(true);

    const groupedPages = getAccessibleNavigationDomains('admin');
    expect(groupedPages.map((domain) => domain.label)).toEqual(
      EXPECTED_DOMAIN_LABELS,
    );
    expect(groupedPages.map((domain) => domain.pages.length)).toEqual([
      2, 3, 3, 4, 5, 4, 4,
    ]);
    expect(
      groupedPages.flatMap((domain) => domain.pages.map((page) => page.path)),
    ).toEqual(EXPECTED_ADMIN_SWITCHER_PATHS);
  });

  it('places the twin graph first in equipment operations and opens it as a safe external link', () => {
    const equipmentPages = getAccessibleNavigationDomains('admin').find(
      (domain) => domain.key === 'equipment',
    )?.pages;
    const navigationSource = readSource(
      'client/src/components/GlobalNavigation.tsx',
    );

    expect(
      equipmentPages?.map((page) => ({
        label: page.label,
        path: page.path,
        external: Reflect.get(page, 'external') === true,
      })),
    ).toEqual([
      {
        label: '孪生图谱',
        path: 'https://www.sm.sjhl.online:8787/',
        external: true,
      },
      {
        label: '设备台账管理',
        path: '/equipment-ledger-management',
        external: false,
      },
      {
        label: '阈值管理',
        path: '/threshold-management',
        external: false,
      },
      {
        label: '设备轮巡',
        path: '/equipment-patrol-dashboard',
        external: false,
      },
      {
        label: '设备定位',
        path: '/exhaust-valve-map',
        external: false,
      },
    ]);
    expect(navigationSource).toContain('target="_blank"');
    expect(navigationSource).toContain('rel="noopener noreferrer"');
  });

  it('shows guest pages in domain order while keeping restricted pages hidden', () => {
    const pages = getAccessibleSwitcherPages('guest');

    expect(pages.map((page) => page.path)).toEqual([
      '/nantong-base',
      '/today-operations-panorama',
      '/monthly-operations',
      '/monthly-schedule',
      '/system-monthly-report',
    ]);
    expect(
      getAccessibleNavigationDomains('guest').map((domain) => domain.label),
    ).toEqual(['平台门户', '运营指挥', '人员保障', '知识交付']);
    expect(
      pages.find((page) => page.path === '/today-operations-panorama')?.label,
    ).toBe('今日航图');
    expect(
      pages.some((page) => page.path === '/campus-operations-dashboard'),
    ).toBe(false);
    expect(pages.some((page) => page.path === '/duty-staff-repair')).toBe(
      false,
    );
  });

  it('keeps purchase administrators inside the same domain ordering', () => {
    expect(
      getAccessibleSwitcherPages('purchase_admin').map((page) => page.path),
    ).toEqual([
      '/nantong-base',
      '/today-operations-panorama',
      '/monthly-operations',
      '/monthly-schedule',
      '/construction-management',
      '/purchase-inventory-management',
      '/contract-management',
      '/system-monthly-report',
    ]);
    expect(
      getAccessibleNavigationDomains('purchase_admin').map(
        (domain) => domain.label,
      ),
    ).toEqual([
      '平台门户',
      '运营指挥',
      '人员保障',
      '运维质量',
      '采‑供‑存',
      '知识交付',
    ]);
  });

  it('matches known child routes to their single global entry', () => {
    expect(
      findNavigationPage('/meeting-management/nantong-weekly')?.label,
    ).toBe('议事航迹');
    expect(
      getAccessibleSwitcherPages('guest').some(
        (page) => page.path === '/meeting-management',
      ),
    ).toBe(false);
    expect(
      getNavigationBrowserTitle('/meeting-management/nantong-weekly'),
    ).toBe('南通全景运维平台 · 知识交付 · 议事航迹');
    expect(findNavigationPage('/today-focus-checklist')?.path).toBe(
      '/today-focus-checklist',
    );
    expect(findNavigationPage('/schedule-calendar')?.path).toBe(
      '/today-focus-checklist',
    );
    expect(findNavigationPage('/contract-management/frameworks')?.path).toBe(
      '/contract-management',
    );
    expect(findNavigationPage('/operations-kb/results')?.path).toBe(
      '/operations-kb',
    );
    expect(findNavigationPage('/operations-kb/records/record-123')?.path).toBe(
      '/operations-kb',
    );
    expect(findNavigationPage('/duty-staff-repair')).toBeUndefined();
    expect(findNavigationPage('/contract-management-other')).toBeUndefined();
  });

  it('derives browser titles from the same domain and page registry', () => {
    expect(getNavigationBrowserTitle('/purchase-inventory-management')).toBe(
      '南通全景运维平台 · 采‑供‑存 · 采购管理',
    );
    expect(getNavigationBrowserTitle('/contract-management/frameworks')).toBe(
      '南通全景运维平台 · 采‑供‑存 · 合同管理',
    );
    expect(getNavigationBrowserTitle('/today-focus-checklist')).toBe(
      '南通全景运维平台 · 运营指挥 · 今日重点',
    );
    expect(getNavigationBrowserTitle('/schedule-calendar')).toBe(
      '南通全景运维平台 · 运营指挥 · 今日重点',
    );
    expect(getNavigationBrowserTitle('/not-registered')).toBeUndefined();
  });
});
