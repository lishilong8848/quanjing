import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function readSource(relativePath: string): string {
  const path = join(process.cwd(), relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('risk inspection dashboard UI', () => {
  it('registers the dashboard as a standalone protected page with a navigation entry', () => {
    const appSource = readSource('client/src/app.tsx');
    const navigationSource = readSource(
      'client/src/navigation/page-switcher.ts',
    );

    expect(appSource).toContain("import('./pages/RiskInspectionDashboard')");
    expect(appSource).toContain('getNavigationBrowserTitle(location.pathname)');
    expect(appSource).not.toContain('ROUTE_BROWSER_TITLES');
    expect(appSource).toContain('path="/risk-inspection-dashboard"');
    expect(appSource).toMatch(
      /path="\/risk-inspection-dashboard"[\s\S]{0,200}?key="risk-inspection-dashboard"/,
    );
    expect(appSource).toContain('path="/quality-assessment"');
    expect(appSource).toMatch(
      /path="\/quality-assessment"[\s\S]{0,200}?key="quality-assessment"/,
    );
    expect(navigationSource).toContain("label: '风险排查'");
    expect(navigationSource).toContain("path: '/risk-inspection-dashboard'");
    expect(navigationSource).toContain("label: '质量评估'");
    expect(navigationSource).toContain("path: '/quality-assessment'");
  });

  it('renders the reference dashboard hierarchy and responsive presentation hooks', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).toContain(
      'data-screenshot-target="risk-inspection-dashboard"',
    );
    expect(pageSource).toContain('现场风险检查-Ali');
    expect(pageSource).toContain('问题全景分布');
    expect(pageSource).toContain('未解决风险问题');
    expect(pageSource).toContain('逾期风险问题');
    expect(pageSource).toContain('整改完成率趋势');
    expect(pageSource).toContain('问题类型分布');
    expect(styles).toContain('.risk-inspection-dashboard');
    expect(styles).toContain('@media (max-width: 980px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps the fixed dashboard stage and dense charts inside their visual bounds', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).toContain('Math.max(viewportHeight, STAGE_HEIGHT)');
    expect(pageSource).toContain('viewportWidth / STAGE_WIDTH');
    expect(pageSource).toContain('height: stageHeight');
    expect(pageSource).not.toContain('minHeight: STAGE_HEIGHT');
    expect(styles).toMatch(
      /\.risk-dashboard-body\s*\{[^}]*grid-template-rows:\s*344px 300px;/s,
    );
    expect(styles).toMatch(
      /\.risk-donut-wrap\s*\{[^}]*width:\s*420px;[^}]*height:\s*276px;/s,
    );
    expect(styles).toMatch(
      /\.risk-right-column\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) 40px;[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.risk-bar-chart\s*\{[^}]*padding:\s*26px 14px 24px 28px;/s,
    );
    expect(styles).toMatch(
      /\.risk-overdue-column\s+\.risk-data-table td\s*\{[^}]*height:\s*33px;/s,
    );
  });

  it('keeps the donut center clear without the shield-check decoration', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).not.toContain('risk-donut-center-core');
    expect(pageSource).not.toContain('risk-donut-center-shield');
    expect(pageSource).not.toContain('risk-donut-center-check');
    expect(styles).not.toContain('.risk-donut-center-core');
    expect(styles).not.toContain('.risk-donut-center-shield');
    expect(styles).not.toContain('.risk-donut-center-check');
  });

  it('uses restrained metric beacons and gradient bars without grid lines', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).not.toContain('function MetricMiniVisual');
    expect(pageSource).not.toContain("visual: 'history'");
    expect(pageSource).toContain('className="risk-metric-beacon"');
    expect(pageSource).not.toContain('risk-metric-spark');
    expect(styles).toContain('.risk-metric-beacon');
    expect(styles).toContain('@keyframes risk-metric-breathe');
    expect(styles).toContain(
      'animation: risk-metric-breathe 4.8s ease-in-out infinite;',
    );
    expect(styles).toMatch(
      /\.risk-metric-beacon::before\s*\{[^}]*animation:\s*none;/s,
    );
    expect(styles).not.toContain('.risk-metric-card::after');
    expect(styles).toContain('.risk-metric-cyan');
    expect(styles).toContain('.risk-metric-indigo');
    expect(styles).not.toContain('repeating-linear-gradient(to bottom');
    expect(styles).toMatch(
      /\.risk-bar-normal\s*\{[^}]*background:\s*linear-gradient\(/s,
    );
    expect(styles).toMatch(
      /\.risk-bar-overdue\s*\{[^}]*background:\s*linear-gradient\(/s,
    );
  });

  it('keeps risk switching at two levels and opens monthly quality in standalone mode', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const crossViewSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossInspectionView.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).toContain(
      "type DashboardView = 'inspection' | 'cross-inspection' | 'monthly-quality'",
    );
    expect(pageSource).toContain('standaloneQuality = false');
    expect(pageSource).toContain(
      "standaloneQuality ? 'monthly-quality' : 'inspection'",
    );
    expect(pageSource).toContain('aria-label="切换风险排查看板"');
    expect(pageSource).toContain("setActiveView('inspection')");
    expect(pageSource).toContain("setActiveView('cross-inspection')");
    expect(pageSource).not.toContain("setActiveView('monthly-quality')");
    expect(pageSource).toContain('阿里月度质量');
    expect(pageSource).toContain('getAliMonthlyQualityDataset');
    expect(pageSource).toContain('<AliMonthlyQualityView');
    expect(pageSource).toContain("activeView === 'monthly-quality'");
    expect(pageSource).toContain('qualityStatus');
    expect(pageSource).toContain('qualityRefreshing');
    expect(pageSource).toContain('<CrossInspectionView');
    expect(crossViewSource).toContain('互查问题一览');
    expect(crossViewSource).toContain('历史遗留问题');
    expect(crossViewSource).toContain('风险台账');
    expect(crossViewSource).toContain('<ComposedChart');
    expect(crossViewSource).toContain('role="search"');
    expect(styles).toContain('.risk-view-switch');
    expect(styles).toMatch(
      /\.risk-cross-dashboard-body\s*\{[^}]*grid-template-rows:\s*300px 344px;/s,
    );
  });

  it('integrates the monthly rating period controls without clipping long content', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const qualityStyles = readSource(
      'client/src/pages/RiskInspectionDashboard/ali-monthly-quality.css',
    );

    expect(pageSource).toContain(
      "const [qualityYear, setQualityYear] = useState('')",
    );
    expect(pageSource).toContain('standaloneQuality');
    expect(pageSource).toContain("? '质量评估'");
    expect(pageSource).toContain('qualityData.options.years.length > 1');
    expect(pageSource).toContain('year={qualityYear}');
    expect(pageSource).toContain('onMonthChange={setQualityMonth}');
    expect(qualityStyles).toMatch(
      /\.quality-dashboard-body\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/s,
    );
    expect(qualityStyles).toMatch(
      /\.quality-stage \.risk-title-group h1\s*\{[^}]*white-space:\s*nowrap;/s,
    );
  });

  it('uses the real mobile viewport for the monthly quality stage', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const qualityStyles = readSource(
      'client/src/pages/RiskInspectionDashboard/ali-monthly-quality.css',
    );

    expect(pageSource).toContain('viewportWidth');
    expect(pageSource).toContain('viewportHeight');
    expect(pageSource).toContain(
      'isMonthlyQuality && viewportWidth <= QUALITY_COMPACT_BREAKPOINT',
    );
    expect(pageSource).toContain('width: stageWidth * stageScale');
    expect(pageSource).toContain('height: stageHeight * stageScale');
    expect(qualityStyles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.quality-stage \.risk-dashboard-header\s*\{[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(qualityStyles).toMatch(
      /\.quality-stage \.quality-header-filters\s*\{[^}]*width:\s*100%;/s,
    );
  });

  it('scopes cross-inspection filters to the risk ledger only', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const crossViewSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossInspectionView.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );
    const propsSource =
      crossViewSource.match(
        /interface CrossInspectionViewProps \{([\s\S]*?)\n\}/,
      )?.[1] ?? '';
    const chartSource = crossViewSource.slice(
      crossViewSource.indexOf('function CrossRectificationChart'),
      crossViewSource.indexOf('function LegacyIssuePanel'),
    );
    const legacySource = crossViewSource.slice(
      crossViewSource.indexOf('function LegacyIssuePanel'),
      crossViewSource.indexOf('function RiskLedgerPanel'),
    );
    const ledgerSource = crossViewSource.slice(
      crossViewSource.indexOf('function RiskLedgerPanel'),
      crossViewSource.indexOf('export function CrossInspectionView'),
    );

    expect(pageSource).not.toContain('risk-cross-filters');
    expect(pageSource).not.toContain('changeCrossMonth');
    expect(pageSource).not.toContain('crossBuilding');
    expect(pageSource).not.toContain('crossMonth');
    expect(pageSource).not.toContain('crossType');
    expect(pageSource).toContain(
      'onClick={() => void loadCross({ refresh: true })}',
    );

    expect(propsSource).toContain('data: CrossInspectionDashboard');
    expect(propsSource).toContain('onOpenDetail:');
    expect(propsSource).not.toContain('building:');
    expect(propsSource).not.toContain('month:');
    expect(propsSource).not.toContain('type:');

    expect(chartSource).toContain('getDefaultCrossOverviewMonth');
    expect(chartSource).toContain('buildCrossBuildingRectification');
    expect(chartSource).toContain('<Select value={overviewMonth}');
    expect(chartSource).toContain('aria-label="互查问题月份"');
    expect(chartSource).not.toContain("building === 'all'");

    expect(legacySource).not.toContain('filterCrossLedgerIssues');
    expect(legacySource).not.toContain('matchesHeaderFilters');
    expect(legacySource).toMatch(
      /data\.legacyIssues\s*\.filter\(\(issue\) =>\s*issue\.description\.includes\(query\.trim\(\)\)\)/s,
    );
    expect(legacySource).toContain('暂无历史遗留未解决问题');
    expect(legacySource).toContain('历史问题均已完成整改闭环');
    expect(legacySource).toContain('未找到匹配的历史遗留问题');
    expect(legacySource).toContain('请尝试调整搜索关键词');
    expect(legacySource).not.toContain('当前筛选条件');

    expect(ledgerSource).toContain('aria-label="风险台账筛选条件"');
    expect(ledgerSource.match(/<Select\s+value=/g) ?? []).toHaveLength(3);
    expect(ledgerSource).toContain('aria-label="楼栋筛选"');
    expect(ledgerSource).toContain('aria-label="月份筛选"');
    expect(ledgerSource).toContain('aria-label="类型筛选"');
    expect(ledgerSource).toContain('filterCrossLedgerIssues(data.issues');
    expect(styles).toContain('.risk-cross-ledger-filters');
    expect(styles).toContain('.risk-cross-empty-state');
  });

  it('keeps risk-ledger pagination valid when records change', () => {
    const crossViewSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossInspectionView.tsx',
    );
    const ledgerSource = crossViewSource.slice(
      crossViewSource.indexOf('function RiskLedgerPanel'),
      crossViewSource.indexOf('export function CrossInspectionView'),
    );

    expect(ledgerSource).toContain(
      'const pageNumbers = getPaginationWindow(currentPage, totalPages);',
    );
    expect(ledgerSource).toMatch(
      /useEffect\(\(\) => \{\s*setPage\(\(current\) => Math\.min\(current, totalPages\)\);\s*\}, \[totalPages\]\);/s,
    );
    expect(ledgerSource).toMatch(
      /useEffect\(\(\) => \{\s*setPage\(1\);\s*\}, \[building, month, query, type\]\);/s,
    );
    expect(ledgerSource).toContain('pageNumbers.map((pageNumber) => (');
    expect(ledgerSource).not.toContain('{Array.from(');
    expect(ledgerSource).toMatch(
      /aria-current=\{pageNumber === currentPage \? 'page' : undefined\}/,
    );
  });

  it('keeps the rectification area curve above the gradient bars', () => {
    const crossViewSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossInspectionView.tsx',
    );

    expect(crossViewSource).toContain('Area,');
    expect(crossViewSource).toContain('id="risk-cross-rate-area-fill"');
    expect(crossViewSource).toContain('<Area');
    expect(crossViewSource).toContain('baseValue={54}');
    expect(crossViewSource).toContain('type="monotone"');
    expect(crossViewSource).toContain(
      '<YAxis yAxisId="count" domain={[0, 20]} hide />',
    );
    expect(crossViewSource).toContain(
      '<YAxis yAxisId="rate" domain={[-50, 112]} hide />',
    );
    expect(crossViewSource.indexOf('<Area')).toBeLessThan(
      crossViewSource.indexOf('<Bar'),
    );
  });

  it('loads both dashboards from typed backend APIs without static issue fixtures', () => {
    const apiSource = readSource('client/src/api/index.ts');
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const crossViewSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossInspectionView.tsx',
    );

    expect(apiSource).toContain('getRiskInspectionAliDashboard');
    expect(apiSource).toContain("url: '/api/risk-inspection/ali'");
    expect(apiSource).toContain('getRiskInspectionCrossDashboard');
    expect(apiSource).toContain("url: '/api/risk-inspection/cross'");
    expect(pageSource).toContain('getRiskInspectionAliDashboard');
    expect(pageSource).toContain('getRiskInspectionCrossDashboard');
    expect(pageSource).toContain('risk-source-state');
    expect(pageSource).toContain("sourceStatus === 'stale'");
    expect(pageSource).toContain('refresh: true');
    expect(pageSource).not.toContain('const SUMMARY');
    expect(pageSource).not.toContain('const CROSS_METRICS =');
    expect(crossViewSource).not.toContain('const BUILDING_RECTIFICATION');
    expect(crossViewSource).not.toContain('const LEGACY_ISSUES');
    expect(crossViewSource).not.toContain('const RISK_LEDGER');
  });

  it('declares the complete Ali issue collection in the shared contract', () => {
    const interfaceSource = readSource('shared/risk-inspection.interface.ts');
    const aliDashboardInterface =
      interfaceSource.match(
        /export interface AliRiskInspectionDashboard \{([\s\S]*?)\n\}/,
      )?.[1] ?? '';

    expect(aliDashboardInterface).toContain('issues: AliRiskIssue[];');
  });

  it('provides one accessible detail dialog for complete dashboard values', () => {
    const dialogSource = readSource(
      'client/src/pages/RiskInspectionDashboard/RiskDetailDialog.tsx',
    );

    expect(dialogSource).toMatch(/<Dialog\s+open=\{Boolean\(detail\)\}/s);
    expect(dialogSource).toContain('<DialogTitle>{detail?.title}');
    expect(dialogSource).toContain('detail?.fields.map');
    expect(dialogSource).toContain('risk-detail-field-wide');
    expect(dialogSource).toContain('aria-label="关闭详情"');
  });

  it('renders a separated dual-ring chart with external and in-ring labels', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const chartLayoutSource = readSource(
      'client/src/pages/RiskInspectionDashboard/chart-layout.ts',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).toContain('PieChart');
    expect(pageSource).toContain('function renderOuterDonutLabel');
    expect(pageSource).toContain('function renderInnerDonutLabel');
    expect(pageSource).toContain(
      '<PanelTitle>问题全景分布（风险等级 × 问题状态）</PanelTitle>',
    );
    expect(pageSource).toContain(
      'innerRadius={RISK_DONUT_GEOMETRY.outerInnerRadius}',
    );
    expect(pageSource).toContain(
      'outerRadius={RISK_DONUT_GEOMETRY.outerRadius}',
    );
    expect(pageSource).toContain(
      'innerRadius={RISK_DONUT_GEOMETRY.innerRadius}',
    );
    expect(pageSource).toContain(
      'outerRadius={RISK_DONUT_GEOMETRY.innerOuterRadius}',
    );
    expect(pageSource).toContain('stroke="#ffffff"');
    expect(pageSource).toContain('strokeWidth={3}');
    expect(pageSource).toContain('risk-donut-leader-line');
    expect(pageSource).toContain('const labelText =');
    expect(pageSource).toContain('textLength={labelWidth}');
    expect(pageSource).toContain('lengthAdjust="spacingAndGlyphs"');
    expect(pageSource).toContain('stroke={color}');
    expect(pageSource.match(/rootTabIndex=\{-1\}/g) ?? []).toHaveLength(2);
    expect(pageSource).not.toContain('rootTabIndex={0}');
    expect(chartLayoutSource).toContain("'#30c7a4'");
    expect(chartLayoutSource).toContain("'#ffb84d'");
    expect(styles).toContain('fill: hsl(0 0% 100% / 0.92)');
    expect(pageSource).not.toContain('className="risk-donut-center-value"');
    expect(styles).toContain('.risk-donut-outer-label');
    expect(styles).toContain('.risk-donut-inner-label');
  });

  it('uses stable color resolvers for legends, labels and sectors', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const chartLayoutSource = readSource(
      'client/src/pages/RiskInspectionDashboard/chart-layout.ts',
    );

    expect(chartLayoutSource).toContain('export function getSeverityColor(');
    expect(chartLayoutSource).toContain('export function getStatusColor(');
    expect(pageSource).toContain('backgroundColor: getColor(item, index)');
    expect(pageSource).toContain('getColor={getSeverityColor}');
    expect(pageSource).toContain('getColor={getStatusColor}');
    expect(pageSource).toMatch(
      /function renderOuterDonutLabel\([\s\S]*?const color = getSeverityColor\(item, index\);/,
    );
    expect(pageSource).toMatch(
      /visibleSeverity\.map\(\(item, index\) => \([\s\S]*?fill=\{getSeverityColor\(item, index\)\}/,
    );
    expect(pageSource).toMatch(
      /visibleStatuses\.map\(\(item, index\) => \([\s\S]*?fill=\{getStatusColor\(item, index\)\}/,
    );
    expect(
      pageSource.match(/getSeverityColor\(item, index\)/g) ?? [],
    ).toHaveLength(2);
    expect(pageSource).not.toContain('colors[index % colors.length]');
    expect(pageSource).not.toContain(
      'STATUS_COLORS[index % STATUS_COLORS.length]',
    );
  });

  it('keeps each external severity label on one readable line', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );

    expect(pageSource).toContain('{labelText}');
    expect(pageSource).not.toContain('className="risk-donut-outer-value"');
  });

  it('binds trend value left position to the mapped point x coordinate', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );

    expect(pageSource).toContain('left: `${leftPercent}%`,');
  });

  it('binds trend value top position to the mapped point y coordinate', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );

    expect(pageSource).toContain('top: `${topPercent}%`,');
  });

  it('does not use a fixed grid for the trend value overlay', () => {
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(styles).not.toMatch(
      /\.risk-line-chart-values\s*\{[^}]*display:\s*grid;/s,
    );
  });

  it('anchors trend and bar values to their rendered chart marks', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).toContain('{points.map((item) => {');
    expect(pageSource).toMatch(
      /getTrendPointLabelLayout\(\s*item\.x,\s*item\.y,\s*\)/s,
    );
    expect(styles).toMatch(
      /\.risk-line-chart-values\s*\{[^}]*height:\s*165px;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).toContain('transform: translate(-50%, calc(-100% - 7px));');
    expect(styles).toMatch(
      /\.risk-trend-value\s*\{[^}]*pointer-events:\s*auto;/s,
    );

    expect(pageSource.match(/className="risk-bar-column"/g) ?? []).toHaveLength(
      2,
    );
    expect(pageSource).toMatch(
      /<div className="risk-bar-column">\s*<span className="risk-bar-value">\{item\.normal\}<\/span>\s*<i\s+className="risk-bar risk-bar-normal"[\s\S]*?\/>\s*<\/div>/,
    );
    expect(pageSource).toMatch(
      /<div className="risk-bar-column">\s*<span className="risk-bar-value">\{item\.overdue\}<\/span>\s*<i\s+className="risk-bar risk-bar-overdue"[\s\S]*?\/>\s*<\/div>/,
    );
    expect(pageSource).toContain(
      '<span className="risk-bar-value">{item.overdue}</span>',
    );
    expect(styles).toMatch(/\.risk-bar-column\s*\{[^}]*gap:\s*4px;/s);
    expect(pageSource).not.toContain('style={{ bottom:');
    expect(styles).not.toContain('.risk-bar-value { position: absolute');
    expect(styles).not.toContain('.risk-bar-value-normal');
    expect(styles).not.toContain('.risk-bar-value-overdue');
    expect(styles).not.toContain('.risk-bar-group:nth-child');
  });

  it('shows compact weekly labels and the renamed overdue metric', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).toContain("label: '延期未闭环'");
    expect(pageSource).toContain("label: '未闭环问题'");
    expect(pageSource).toContain("key: 'unclosed'");
    expect(pageSource).toContain('dashboard={dashboard}');
    expect(styles).toContain(
      'grid-template-columns: repeat(6, minmax(0, 1fr))',
    );
    expect(pageSource).not.toContain("label: '未登记问题'");
    expect(pageSource).toContain('aliData.overdueIssues.length');
    expect(pageSource).toContain('formatRiskTrendPeriod');
    expect(pageSource).toContain('<strong>{period.yearLabel}</strong>');
    expect(pageSource).toContain('className="risk-line-chart-week"');
    expect(pageSource).toContain('{period.weekLabel}');
    expect(pageSource).toContain('<small>{period.rangeLabel}</small>');
    expect(styles).toContain('.risk-line-chart-week');
    expect(styles).toContain('.risk-line-chart-labels small');
    expect(styles).toMatch(
      /\.risk-panorama-panel\s*>\s*div\s*\{[^}]*padding:\s*10px 16px 8px;/s,
    );
  });

  it('opens concrete issue lists from cards and charts, then single issue details from rows', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const crossViewSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossInspectionView.tsx',
    );
    const crossDialogSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossIssueListDialog.tsx',
    );
    const aliDialogSource = readSource(
      'client/src/pages/RiskInspectionDashboard/RiskMetricListDialog.tsx',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(pageSource).toContain(
      'const [detail, setDetail] = useState<RiskDetailPayload | null>(null)',
    );
    expect(pageSource).toContain('<RiskDetailDialog');
    expect(pageSource).toContain('<RiskMetricListDialog');
    expect(pageSource).toContain('<CrossIssueListDialog');
    expect(pageSource).toContain('const [metricListKey, setMetricListKey]');
    expect(pageSource).toContain(
      'const [aliIssueListSelection, setAliIssueListSelection]',
    );
    expect(pageSource).toContain(
      'const [crossMetricListKey, setCrossMetricListKey]',
    );
    expect(pageSource).not.toContain('createMetricDetail');
    expect(pageSource).not.toContain('createDistributionDetail');
    expect(pageSource).not.toContain('createTrendDetail');
    expect(pageSource).not.toContain('createCategoryDetail');
    expect(pageSource).toContain('createAliIssueDetail');
    expect(pageSource).toContain('role="button"');
    expect(pageSource).toContain('tabIndex={0}');
    expect(crossViewSource).toContain('onOpenDetail');
    expect(crossViewSource).toContain('onOpenIssueList');
    expect(crossViewSource).toContain('createCrossIssueDetail');
    expect(crossViewSource).not.toContain('createCrossBuildingDetail');
    expect(aliDialogSource).toContain(
      'selection: AliIssueListSelection | null',
    );
    expect(crossDialogSource).toContain('selectCrossMetricIssues');
    expect(crossDialogSource).toContain('filterCrossMetricIssues');
    expect(crossDialogSource).toContain('查看详情');
    expect(crossDialogSource).toContain("dataset.state !== 'closed'");
    expect(crossDialogSource).toContain('requestAnimationFrame');
    expect(styles).toContain('.risk-clickable');
    expect(styles).toContain('.risk-detail-dialog');
    expect(styles).toContain('.risk-detail-fields');
  });

  it('binds every Ali chart interaction to the matching issue-list scope', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );

    expect(pageSource).toContain('selectAliChartIssues');
    expect(pageSource).toContain("kind: 'severity'");
    expect(pageSource).toContain("kind: 'status'");
    expect(pageSource).toContain("kind: 'specialty'");
    expect(pageSource).toContain("kind: 'trend'");
    expect(pageSource).toContain('setAliIssueListSelection');
  });

  it('binds all four cross-inspection cards to their concrete issue lists', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const crossMetricSource = pageSource.slice(
      pageSource.indexOf('? CROSS_METRIC_DEFINITIONS.map('),
      pageSource.indexOf(': METRICS.map('),
    );

    expect(crossMetricSource).toContain('setCrossMetricListKey(key)');
    expect(crossMetricSource).not.toContain('createMetricDetail');
    expect(pageSource).toContain("key: 'closureRate'");
    expect(pageSource).toContain("label: '问题销项率'");
    expect(pageSource).toContain("key === 'closureRate'");
    expect(pageSource).toContain('metricKey={crossMetricListKey}');
  });

  it('provides an independent overview month, readable fixed-width tags, and a source-backed guide dialog', () => {
    const crossViewSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossInspectionView.tsx',
    );
    const guideDialogSource = readSource(
      'client/src/pages/RiskInspectionDashboard/CrossInspectionGuideDialog.tsx',
    );
    const apiSource = readSource('client/src/api/index.ts');
    const controllerSource = readSource(
      'server/modules/risk-inspection/risk-inspection.controller.ts',
    );
    const styles = readSource(
      'client/src/pages/RiskInspectionDashboard/styles.css',
    );

    expect(crossViewSource).toContain('title="互查问题一览"');
    expect(crossViewSource).toContain('setOverviewMonth');
    expect(crossViewSource).toContain('查看互查互纠标准与指引');
    expect(crossViewSource).toContain('<CrossInspectionGuideDialog');
    expect(crossViewSource).toContain('className="risk-cross-tag-badge"');
    expect(crossViewSource).toContain('title={issue.tag}');
    expect(styles).toMatch(
      /\.risk-cross-tag-badge\s*\{[^}]*width:\s*84px;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );

    expect(guideDialogSource).toContain('互查互纠标准与指引');
    expect(guideDialogSource).toContain('getRiskInspectionCrossGuides');
    expect(guideDialogSource).toContain('风险排查标准-体系');
    expect(guideDialogSource).toContain('风险排查标准-阿里');
    expect(guideDialogSource).toContain('环境检查标准');
    expect(apiSource).toContain('getRiskInspectionCrossGuides');
    expect(apiSource).toContain("url: '/api/risk-inspection/cross/guides'");
    expect(controllerSource).toContain("@Get('cross/guides')");
  });

  it('opens concrete Ali issue lists from every metric card', () => {
    const pageSource = readSource(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
    );
    const dialogSource = readSource(
      'client/src/pages/RiskInspectionDashboard/RiskMetricListDialog.tsx',
    );
    const aliMetricSource = pageSource.slice(
      pageSource.indexOf(': METRICS.map('),
      pageSource.indexOf('</section>', pageSource.indexOf(': METRICS.map(')),
    );

    expect(pageSource).toContain("key: 'overdueUnclosed'");
    expect(pageSource).not.toContain("key: 'unrecorded'");
    expect(aliMetricSource).toContain('setMetricListKey(key)');
    expect(aliMetricSource).not.toContain('createMetricDetail');
    expect(dialogSource.includes('filterIssueList')).toBe(true);
    expect(dialogSource).toContain('[10, 20, 50]');
    expect(dialogSource).toContain('未找到匹配的问题');
    expect(dialogSource).toContain('查看详情');
    expect(dialogSource).not.toContain('role="button"');
    expect(dialogSource).not.toContain('tabIndex={0}');
    expect(dialogSource).toContain('onAnimationEnd=');
    expect(dialogSource).toContain("dataset.state !== 'closed'");
    expect(dialogSource).toContain('requestAnimationFrame');
    expect(dialogSource).toMatch(
      /<Button[\s\S]*?aria-label=\{`查看详情：\$\{issue\.description\}`\}/,
    );
    expect(aliMetricSource).not.toMatch(
      /setMetricListKey\(null\);[\s\S]*?setDetail\(createAliIssueDetail\(issue\)\)/,
    );
  });

  it('prioritizes metric-empty states over a retained search query', () => {
    const dialogSource = readSource(
      'client/src/pages/RiskInspectionDashboard/RiskMetricListDialog.tsx',
    );
    const emptyStateStart = dialogSource.indexOf('const emptyState =');
    const emptyStateSource = dialogSource.slice(
      emptyStateStart,
      dialogSource.indexOf('return (', emptyStateStart),
    );
    const metricEmptyGuard = emptyStateSource.indexOf(
      'metricIssues.length === 0',
    );
    const rectificationEmptyCopy =
      emptyStateSource.indexOf('本期无纳入整改完成率计算的问题');
    const metricEmptyCopy = emptyStateSource.indexOf(
      '暂无符合“${dialogTitle}”口径的问题',
    );
    const searchEmptyGuard = emptyStateSource.indexOf(
      'metricIssues.length > 0 && filteredIssues.length === 0',
    );
    const searchEmptyCopy = emptyStateSource.indexOf('未找到匹配的问题');

    expect(metricEmptyGuard).toBeGreaterThan(-1);
    expect(rectificationEmptyCopy).toBeGreaterThan(metricEmptyGuard);
    expect(metricEmptyCopy).toBeGreaterThan(metricEmptyGuard);
    expect(searchEmptyGuard).toBeGreaterThan(metricEmptyCopy);
    expect(searchEmptyCopy).toBeGreaterThan(searchEmptyGuard);
  });
});
