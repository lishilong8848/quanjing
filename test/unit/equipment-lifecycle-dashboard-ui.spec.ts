import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

import { canAccessPage } from '../../client/src/access/access-policy';
import {
  getAccessibleNavigationDomains,
  getAccessibleSwitcherPages,
} from '../../client/src/navigation/page-switcher';
import type { AccessRole } from '../../shared/access-control.interface';

function readSource(relativePath: string): string {
  const path = join(process.cwd(), relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

type RouteNode = ts.JsxElement | ts.JsxSelfClosingElement;

function getStandaloneDashboardRoute(appSource: string) {
  const sourceFile = ts.createSourceFile(
    'app.tsx',
    appSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const isRouteNode = (node: ts.Node): node is RouteNode => {
    if (ts.isJsxElement(node)) {
      return node.openingElement.tagName.getText(sourceFile) === 'Route';
    }
    return (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === 'Route'
    );
  };
  const getRouteAttribute = (route: RouteNode, name: string) =>
    (ts.isJsxElement(route)
      ? route.openingElement.attributes.properties
      : route.attributes.properties
    ).find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) &&
        property.name.getText(sourceFile) === name,
    );
  const getElementExpressionText = (route: RouteNode) => {
    const initializer = getRouteAttribute(route, 'element')?.initializer;
    return initializer &&
      ts.isJsxExpression(initializer) &&
      initializer.expression
      ? initializer.expression.getText(sourceFile)
      : null;
  };
  const getPath = (route: RouteNode) => {
    const initializer = getRouteAttribute(route, 'path')?.initializer;
    return initializer && ts.isStringLiteral(initializer)
      ? initializer.text
      : null;
  };
  const getDescendantRoutes = (root: ts.Node) => {
    const routes: RouteNode[] = [];
    const visit = (node: ts.Node) => {
      if (isRouteNode(node)) routes.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
    return routes;
  };

  const guardRoute = getDescendantRoutes(sourceFile).find(
    (route): route is ts.JsxElement =>
      ts.isJsxElement(route) &&
      getElementExpressionText(route) === '<RouteAccessGuard />',
  );
  const standaloneRoute = guardRoute
    ? getDescendantRoutes(guardRoute).find(
        (route): route is ts.JsxElement =>
          ts.isJsxElement(route) &&
          getElementExpressionText(route) === '<StandaloneAccessLayout />',
      )
    : undefined;
  const dashboardRoute = standaloneRoute
    ? getDescendantRoutes(standaloneRoute).find(
        (route): route is ts.JsxSelfClosingElement =>
          ts.isJsxSelfClosingElement(route) &&
          getPath(route) === '/equipment-lifecycle-dashboard' &&
          getElementExpressionText(route) ===
            '<Navigate replace to="/equipment-ledger-management?view=lifecycle" />',
      )
    : undefined;

  return { guardRoute, standaloneRoute, dashboardRoute };
}

describe('equipment lifecycle dashboard UI', () => {
  it('registers a protected standalone route, browser title and navigation entries', () => {
    const appSource = readSource('client/src/app.tsx');
    const switcherSource = readSource('client/src/navigation/page-switcher.ts');
    const hierarchy = getStandaloneDashboardRoute(appSource);

    expect(
      readSource('client/src/pages/EquipmentLedgerManagement/index.tsx'),
    ).toContain("import('../EquipmentLifecycleDashboard')");
    expect(appSource).toContain('getNavigationBrowserTitle(location.pathname)');
    expect(appSource).not.toContain('ROUTE_BROWSER_TITLES');
    expect(hierarchy.guardRoute).toBeDefined();
    expect(hierarchy.standaloneRoute).toBeDefined();
    expect(hierarchy.dashboardRoute).toBeDefined();
    expect(switcherSource).toContain("label: '设备生命周期'");
    expect(switcherSource).toContain("path: '/equipment-lifecycle-dashboard'");
  });

  it('keeps lifecycle inside the ledger instead of duplicating application menus', () => {
    for (const role of ['admin', 'editor', 'building_admin'] as const) {
      const equipment = getAccessibleNavigationDomains(role).find(
        (domain) => domain.key === 'equipment',
      );
      expect(equipment?.pages.map((page) => page.key)).not.toContain(
        'equipment-lifecycle-dashboard',
      );
      expect(equipment?.pages.map((page) => page.key)).toContain(
        'equipment-ledger-management',
      );
      expect(
        getAccessibleSwitcherPages(role).map((page) => page.key),
      ).not.toContain('equipment-lifecycle-dashboard');
    }
  });

  it('limits the dashboard to general administrators', () => {
    const pathname = '/equipment-lifecycle-dashboard';
    const allowedRoles: AccessRole[] = ['admin', 'editor', 'building_admin'];
    const deniedRoles: AccessRole[] = [
      'guest',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
      'duty_editor',
      'supply_chain_admin',
      'construction_admin',
    ];

    for (const role of allowedRoles) {
      expect(canAccessPage(role, pathname)).toBe(true);
    }
    for (const role of deniedRoles) {
      expect(canAccessPage(role, pathname)).toBe(false);
    }
  });

  it('renders the reference hierarchy, six metrics and complete ledger controls', () => {
    const pageSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/index.tsx',
    );
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );

    expect(pageSource).toContain(
      'data-screenshot-target="equipment-lifecycle-dashboard"',
    );
    expect(pageSource).toContain('设备全生命周期');
    expect(pageSource).toContain('设备总数');
    expect(pageSource).toContain('关键零件总数');
    expect(pageSource).toContain('设备到期数');
    expect(pageSource).toContain('过保合同数');
    expect(pageSource).toContain('维护合同总数');
    expect(pageSource).toContain('长期维护总数');
    expect(pageSource).toContain('设备使用状态');
    expect(pageSource).toContain('长期维护项情况');
    expect(pageSource).toContain('维护合同情况');
    expect(pageSource).toContain('关键器件预警情况');
    expect(pageSource).toContain('设备到期情况');
    expect(pageSource).toContain('设备数量 TOP5');
    expect(pageSource).toContain('设备台账清单');
    expect(pageSource).toContain('className="lifecycle-metric-content"');
    expect(pageSource).toContain('className="lifecycle-panel-content"');
    expect(pageSource).toContain('className="lifecycle-ledger-content"');
    expect(pageSource).toContain('按楼栋查询');
    expect(pageSource).toContain('按专业查询');
    expect(pageSource).toContain('按管理员查询');
    expect(pageSource).toContain('按状态查询');
    expect(pageSource).toContain('清除筛选');
    expect(pageSource).toContain('aria-busy={isLoading}');
    expect(pageSource).toContain('aria-live="polite"');
    expect(pageSource).toContain('设备生命周期看板暂时无法加载');
    expect(chartSource).toContain('<linearGradient');
    expect(chartSource).toContain('<BarChart');
    expect(chartSource).toContain('<PieChart');
    expect(chartSource).toContain('ticks={yAxisTicks}');
    expect(chartSource).toContain('lifecycle-heatmap-legend-levels');
    expect(styles).toMatch(
      /\.lifecycle-heatmap-legend-levels\s*\{[^}]*display:\s*flex;/s,
    );
  });

  it('renders gradient bar charts without cartesian grid lines', () => {
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );

    expect(chartSource).not.toContain('CartesianGrid');
    expect(chartSource).toContain('<BarChart');
    expect(chartSource).toContain('<XAxis');
    expect(chartSource).toContain('<YAxis');
    expect(chartSource).toContain('<linearGradient');
  });

  it('uses an unscaled responsive stage with natural vertical scrolling', () => {
    const pageSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );
    const intermediateDesktopMediaStart = styles.indexOf(
      '@media (min-width: 1401px) and (max-width: 1671px)',
    );
    const compactMediaStart = styles.indexOf('@media (max-width: 1400px)');
    const twoColumnMediaStart = styles.indexOf('@media (max-width: 780px)');
    const mobileMediaStart = styles.indexOf('@media (max-width: 520px)');

    expect(pageSource).not.toContain('useResponsiveStage');
    expect(pageSource).not.toContain('transform: `scale(${scale})`');
    expect(pageSource).not.toContain('style={frameStyle}');
    expect(pageSource).not.toContain('style={stageStyle}');
    expect(styles).not.toContain('transform-origin');
    expect(styles).toMatch(
      /\.lifecycle-dashboard-frame\s*\{[^}]*width:\s*min\(100%,\s*1672px\);[^}]*height:\s*1240px;/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-dashboard-stage\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
    );
    expect(styles).toContain('@media (max-width: 1400px)');
    expect(styles).toContain('@media (max-width: 780px)');
    expect(styles).not.toContain('@media (max-width: 680px)');
    expect(styles).toMatch(
      /\.equipment-lifecycle-dashboard\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-ledger-scroll\s*\{[^}]*overflow-x:\s*auto;/s,
    );
    expect(intermediateDesktopMediaStart).toBeGreaterThanOrEqual(0);
    expect(compactMediaStart).toBeGreaterThan(intermediateDesktopMediaStart);

    const intermediateDesktopStyles = styles.slice(
      intermediateDesktopMediaStart,
      compactMediaStart,
    );
    expect(intermediateDesktopStyles).toMatch(
      /\.lifecycle-usage-ring-trigger\s*\{[^}]*width:\s*100%;/s,
    );
    expect(intermediateDesktopStyles).toMatch(
      /\.lifecycle-usage-ring-chart\s*\{[^}]*width:\s*min\(100%,\s*106px\);[^}]*height:\s*auto;[^}]*aspect-ratio:\s*1;[^}]*align-self:\s*center;/s,
    );
    expect(intermediateDesktopStyles).toMatch(
      /\.lifecycle-usage-ring-center\s*\{[^}]*inset:\s*20\.75%;/s,
    );
    expect(twoColumnMediaStart).toBeGreaterThan(compactMediaStart);
    expect(mobileMediaStart).toBeGreaterThan(twoColumnMediaStart);

    const twoColumnStyles = styles.slice(twoColumnMediaStart, mobileMediaStart);
    expect(twoColumnStyles).toMatch(
      /\.lifecycle-metric-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(twoColumnStyles).toMatch(
      /\.lifecycle-metric-content\s*\{[^}]*grid-template-columns:\s*58px minmax\(70px,\s*1fr\) 66px;/s,
    );
  });

  it('uses layered gradient rings and readable ledger density', () => {
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );

    expect(chartSource).toContain('const trackGradientId');
    expect(chartSource).toContain('const blueGradientId');
    expect(chartSource).toContain('const orangeGradientId');
    expect(chartSource).toContain('className="lifecycle-usage-ring-track"');
    expect(chartSource).toContain('cornerRadius={6}');
    expect(styles).toMatch(
      /\.lifecycle-metric-copy strong\s*\{[^}]*font-size:\s*34px;/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-panel-header h2\s*\{[^}]*font-size:\s*18px;/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-ledger-table\s*\{[^}]*font-size:\s*12px;/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-ledger-table th\s*\{[^}]*height:\s*30px;/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-ledger-table td\s*\{[^}]*height:\s*30px;/s,
    );
    expect(styles).toContain(
      '.lifecycle-ledger-scroll::-webkit-scrollbar-thumb',
    );
  });

  it('uses restrained percentage typography and single-line usage status labels', () => {
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );

    expect(
      chartSource.match(/className="lifecycle-usage-status-label"/g) || [],
    ).toHaveLength(2);
    expect(
      chartSource.match(/className="lifecycle-usage-status-count"/g) || [],
    ).toHaveLength(2);
    expect(styles).toMatch(
      /\.lifecycle-usage-ring-center strong\s*\{(?=[^}]*font-size:\s*16px;)(?=[^}]*line-height:\s*18px;)[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-usage-ring-center span\s*\{(?=[^}]*font-size:\s*11px;)(?=[^}]*line-height:\s*14px;)[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-usage-counts strong\s*\{[^}]*font-size:\s*11px;/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-usage-status-label,\s*\.lifecycle-usage-status-count\s*\{(?=[^}]*display:\s*block;)[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-usage-status-label\s*\{(?=[^}]*white-space:\s*nowrap;)[^}]*\}/s,
    );
  });

  it('keeps the visible evaluation label mapped to the pending-evaluation drill-down status', () => {
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );
    const statusIndex = chartSource.indexOf("status: '待评估'");
    const labelIndex = chartSource.indexOf('>需评估</span>', statusIndex);
    const buttonEndIndex = chartSource.indexOf('</button>', statusIndex);

    expect(statusIndex).toBeGreaterThan(-1);
    expect(labelIndex).toBeGreaterThan(statusIndex);
    expect(buttonEndIndex).toBeGreaterThan(labelIndex);
  });

  it('uses compact numeric month labels that stay on one line', () => {
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );

    const chineseWordMonthLabels = [
      '一月',
      '二月',
      '三月',
      '四月',
      '五月',
      '六月',
      '七月',
      '八月',
      '九月',
      '十月',
      '十一月',
      '十二月',
    ] as const;

    for (let month = 1; month <= 12; month += 1) {
      expect(chartSource).toContain(`'${month}月'`);
    }
    for (const month of chineseWordMonthLabels) {
      expect(chartSource).not.toContain(`'${month}'`);
    }
    expect(styles).toMatch(
      /\.lifecycle-heatmap-month\s*\{(?=[^}]*font-size:\s*10px;)(?=[^}]*line-height:\s*14px;)(?=[^}]*white-space:\s*nowrap;)[^}]*\}/s,
    );
  });

  it('fits usage status rows inside the fixed track at narrow desktop widths', () => {
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );

    expect(styles).toMatch(
      /\.lifecycle-usage-ring\s*\{(?=[^}]*grid-template-rows:\s*106px 26px 42px;)[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-usage-counts\s*\{(?=[^}]*width:\s*100%;)(?=[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);)(?=[^}]*gap:\s*4px;)(?=[^}]*line-height:\s*13px;)[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-usage-counts button\s*\{(?=[^}]*width:\s*100%;)(?=[^}]*padding:\s*1px 2px;)[^}]*\}/s,
    );
    expect(styles).toMatch(
      /\.lifecycle-usage-status-count\s*\{(?=[^}]*font-size:\s*10px;)(?=[^}]*line-height:\s*12px;)[^}]*\}/s,
    );

    const statusLineHeight = 13;
    const countLineHeight = 12;
    const verticalButtonPadding = 1;
    const statusTrackHeight = 42;

    expect(
      statusLineHeight * 2 + countLineHeight + verticalButtonPadding * 2,
    ).toBeLessThanOrEqual(statusTrackHeight);
  });

  it('keeps narrow heatmap month labels separated with local scrolling', () => {
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );
    const narrowMobileMediaStart = styles.indexOf('@media (max-width: 520px)');

    expect(narrowMobileMediaStart).toBeGreaterThanOrEqual(0);
    const narrowMobileStyles = styles.slice(narrowMobileMediaStart);
    expect(narrowMobileStyles).toMatch(
      /\.lifecycle-heatmap-panel \.lifecycle-panel-body\s*\{(?=[^}]*overflow-x:\s*auto;)(?=[^}]*overflow-y:\s*hidden;)[^}]*\}/s,
    );
    expect(narrowMobileStyles).toMatch(
      /\.lifecycle-heatmap\s*\{(?=[^}]*min-width:\s*360px;)[^}]*\}/s,
    );
  });

  it('loads real dashboard data with retry, refresh and request race protection', () => {
    const apiSource = readSource('client/src/api/index.ts');
    const pageSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/index.tsx',
    );
    const modelSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/model.ts',
    );

    expect(apiSource).toContain('getEquipmentLifecycleDashboard');
    expect(apiSource).toContain("url: '/api/equipment-lifecycle/dashboard'");
    expect(pageSource).toContain('getEquipmentLifecycleDashboard');
    expect(pageSource).toContain('requestSequenceRef');
    expect(pageSource).toContain('refresh: true');
    expect(pageSource).toContain("sourceStatus === 'stale'");
    expect(pageSource).toContain("sourceStatus === 'partial'");
    expect(pageSource).toContain('lifecycle-source-warning');
    expect(pageSource).toContain('data-screenshot-ready={view !== null');
    expect(pageSource).not.toContain('window.location.reload()');
    expect(pageSource).not.toContain('getEquipmentLifecycleView');
    expect(pageSource).not.toContain('LIFECYCLE_MONTHS');
    expect(pageSource).not.toContain('DEFAULT_LIFECYCLE_MONTH');
    expect(modelSource).not.toContain('SUMMARY_BY_MONTH');
    expect(modelSource).not.toContain('ASSET_TEMPLATES');
  });

  it('renders metric visuals and bar scales from the response instead of fixed fixtures', () => {
    const pageSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/index.tsx',
    );
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );

    expect(chartSource).not.toContain('METRIC_CHART_DATA');
    expect(chartSource).not.toContain('value: 72');
    expect(chartSource).not.toContain('value="72%"');
    expect(chartSource).toContain('MetricStatusLamp');
    expect(chartSource).not.toContain('MetricMiniChart');
    expect(pageSource).toContain('LifecycleDrilldownDialog');
    expect(pageSource).toContain('buildLifecycleDrilldown');
    expect(pageSource).toContain('openDrilldown');
    expect(chartSource).toContain('onSelect');
    expect(chartSource).toContain('type="button"');
    expect(pageSource).toContain('maintenanceContractInWarrantyRate');
    expect(pageSource).toContain('getChartMax');
    expect(pageSource).not.toContain('maxValue={15}');
    expect(pageSource).not.toContain('maxValue={40}');
    expect(pageSource).not.toContain('maxValue={6}');
    expect(pageSource).toContain("value === null ? '—'");
    expect(pageSource).toContain("dataKey: 'expired'");
    expect(pageSource).not.toContain("dataKey: 'inProcurement'");
  });

  it('uses a slow semantic breathing lamp with reduced-motion support', () => {
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );

    expect(chartSource).toContain('export function MetricStatusLamp');
    expect(chartSource).toContain('aria-hidden="true"');
    expect(styles).toContain('@keyframes lifecycle-status-breathe');
    expect(styles).toMatch(
      /\.lifecycle-status-lamp-halo\s*\{[^}]*animation:\s*lifecycle-status-breathe 3\.6s/s,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.lifecycle-status-lamp-halo[\s\S]*animation:\s*none/s,
    );
  });

  it('removes the tinted metric-card corner layer while keeping status lamps', () => {
    const chartSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/charts.tsx',
    );
    const styles = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/styles.css',
    );

    expect(styles).not.toContain('.lifecycle-metric-card::after');
    expect(chartSource).toContain('export function MetricStatusLamp');
    expect(chartSource).toContain('className="lifecycle-status-lamp"');
    expect(styles).toContain('.lifecycle-status-lamp-halo');
  });

  it('provides one accessible detail dialog for all dashboard drilldowns', () => {
    const pageSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/index.tsx',
    );
    const dialogSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/LifecycleDrilldownDialog.tsx',
    );

    expect(dialogSource).toContain('<Dialog');
    expect(dialogSource).toContain('<DialogTitle>');
    expect(dialogSource).toContain('<DialogDescription className="sr-only">');
    expect(dialogSource).toContain('showCloseButton={false}');
    expect(dialogSource).toContain('onOpenChange(false)}>关闭</Button>');
    expect(dialogSource).toContain('lifecycle-drilldown-table');
    expect(dialogSource).toContain('暂无匹配清单');
    expect(pageSource).toContain('<LifecycleDrilldownDialog');
    expect(pageSource).toContain('onOpenChange');
  });

  it('uses the full asset ledger total and labels long-term expiry correctly', () => {
    const pageSource = readSource(
      'client/src/pages/EquipmentLifecycleDashboard/index.tsx',
    );
    const longTermSeries = pageSource.slice(
      pageSource.indexOf('const LONG_TERM_SERIES'),
      pageSource.indexOf('const CONTRACT_SERIES'),
    );

    expect(pageSource).toContain(
      'catalogTotal={view.summary.equipmentTotal ?? view.assets.length}',
    );
    expect(pageSource).toContain('已排除主变条目的长期维护清单');
    expect(longTermSeries).toContain("label: '到期'");
    expect(longTermSeries).not.toContain("label: '过保'");
    expect(pageSource).toMatch(
      /<LegendItem\s+label="到期"\s+tone="red"[\s\S]*?status:\s*'到期'/,
    );
    expect(pageSource).toContain('ariaLabel="各楼栋长期维护在保与到期数量"');
    expect(pageSource).toContain('formatUpdatedAt(view.updatedAt)');
  });
});
