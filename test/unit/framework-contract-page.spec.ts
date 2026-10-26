import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  const filePath = path.join(root, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

describe('framework contract relationship page source contract', () => {
  const appSource = readSource('client/src/app.tsx');
  const layoutSource = readSource('client/src/components/Layout.tsx');
  const navigationSource = readSource('client/src/navigation/page-switcher.ts');
  const pageSource = readSource(
    'client/src/pages/ContractManagement/FrameworkContractsPage.tsx',
  );

  it('registers a lazy exact route and derives its title from navigation', () => {
    expect(appSource).toContain('const FrameworkContractsPage = React.lazy(');
    expect(appSource).toContain(
      "() => import('./pages/ContractManagement/FrameworkContractsPage')",
    );
    expect(appSource).toContain('getNavigationBrowserTitle(location.pathname)');
    expect(appSource).not.toContain('ROUTE_BROWSER_TITLES');
    expect(navigationSource).toContain("label: '合同管理'");
    expect(navigationSource).toContain("domainKey: 'supply'");
    expect(appSource).toContain('path="/contract-management/frameworks"');
    expect(appSource).toContain('element={<FrameworkContractsPage />}');
  });

  it('keeps the contract overview and every child route immersive', () => {
    expect(layoutSource).toMatch(
      /pathname === '\/contract-management'[\s\S]*pathname\.startsWith\('\/contract-management\/'\)/,
    );
  });

  it('uses the live dashboard, shared header, and framework relationship copy', () => {
    const headerStart = pageSource.indexOf('<ManagementHeader');
    const mainStart = pageSource.indexOf('<main', headerStart);
    const headerUsage =
      headerStart >= 0 && mainStart > headerStart
        ? pageSource.slice(headerStart, mainStart)
        : '';
    const mainSource = mainStart >= 0 ? pageSource.slice(mainStart) : '';

    expect(pageSource).toContain('getContractManagementDashboard');
    expect(pageSource).toContain(
      'getContractManagementDashboard(forceRefresh)',
    );
    expect(pageSource).toContain('ManagementHeader');
    expect(pageSource).not.toContain(
      "import { ManagementPageSwitcher } from '../PurchaseInventoryManagement/ManagementPageSwitcher';",
    );
    expect(headerUsage).toContain('activePage="contract"');
    expect(headerUsage).toContain(
      'updatedAt={formatUpdatedAt(dashboard?.generatedAt)}',
    );
    expect(pageSource).not.toContain('<ManagementPageSwitcher');
    expect(mainSource).not.toContain('数据更新时间：');
    expect(pageSource).not.toContain('activeTab="contract"');
    expect(pageSource).not.toContain('showPrimaryAction={false}');
    expect(pageSource).toContain('搜索框架合同名称或编号');
    expect(pageSource).toContain('返回合同总览');
    expect(pageSource).toContain('to="/contract-management"');
    expect(pageSource).toContain('框架合同与执行合同关联');
    expect(pageSource).not.toContain(
      '关联结果仅来自多维表真实关联字段，不按名称或编号推测。',
    );
    expect(pageSource).toContain('框架合同清单');
  });

  it('shows effective execution contract counts in framework contract lists', () => {
    expect(pageSource).toContain('countEffectiveExecutionContracts');
    expect(pageSource).toContain('有效执行合同');
    expect(pageSource).not.toMatch(
      /item\.executionContracts\.length\s*>\s*0[\s\S]{0,160}份执行合同/,
    );
  });

  it('coordinates only the latest request and disables duplicate entry points', () => {
    const loadFailureSource =
      pageSource.match(
        /function LoadFailure\([\s\S]*?\n}\n\nfunction formatUpdatedAt/,
      )?.[0] ?? '';

    expect(pageSource).toContain(
      "import { createLatestRequestCoordinator } from './latest-request';",
    );
    expect(pageSource).toContain(
      'const [requestCoordinator] = useState(createLatestRequestCoordinator);',
    );
    expect(pageSource).toContain('await requestCoordinator.run(');
    expect(pageSource).toContain(
      'getContractManagementDashboard(forceRefresh),',
    );
    expect(pageSource).toContain('onSuccess: (response) => {');
    expect(pageSource).toContain('onError: () => {');
    expect(pageSource).toContain('onSettled: () => {');
    expect(pageSource).toMatch(
      /useEffect\(\(\) => \{\s*void loadDashboard\(false\);\s*return \(\) => \{\s*requestCoordinator\.invalidate\(\);\s*};\s*}, \[loadDashboard, requestCoordinator\]\);/,
    );
    expect(pageSource).not.toContain('requestSequenceRef');
    expect(pageSource).toContain('refreshing={loading || refreshing}');
    expect(pageSource).toContain('busy={loading || refreshing}');
    expect(loadFailureSource).toContain('busy: boolean;');
    expect(loadFailureSource).toContain('disabled={busy}');
  });

  it('keeps the last dashboard visible when a background refresh fails', () => {
    const refreshFailureBranch =
      pageSource.match(
        /onError: \(\) => \{[\s\S]*?if \(dashboardRef\.current\) \{([\s\S]*?)\} else \{/,
      )?.[1] ?? '';

    expect(refreshFailureBranch).toContain('setRefreshError(');
    expect(refreshFailureBranch).not.toContain('setDashboard(');
    expect(pageSource).toContain('{refreshing && dashboard && (');
    expect(pageSource).toMatch(
      /\{refreshError && dashboard && \(\s*<Notice tone="warning">[\s\S]*?\{refreshError\}[\s\S]*?<\/Notice>\s*\)\}/,
    );
    expect(pageSource).toMatch(
      /\{loading && !dashboard \? \([\s\S]*?\) : !dashboard \? \([\s\S]*?\) : \(\s*<>[\s\S]*?<SummaryCards summary=\{dashboard\.frameworkRelations\.summary\} \/>/,
    );
  });

  it('renders the four summaries and four real pressed-state filters', () => {
    expect(pageSource).toContain('summary.totalFrameworks');
    expect(pageSource).toContain('summary.linkedFrameworks');
    expect(pageSource).toContain('summary.linkedExecutionContracts');
    expect(pageSource).toContain('summary.linkedExecutionAmount');
    expect(pageSource).toContain("label: '全部'");
    expect(pageSource).toContain("label: '已关联'");
    expect(pageSource).toContain("label: '待关联'");
    expect(pageSource).toContain("label: '即将到期'");
    expect(pageSource).toContain('<button');
    expect(pageSource).toContain('aria-pressed={');
  });

  it('renders real execution contract detail fields', () => {
    expect(pageSource).toContain('item.executionContracts.map((contract) => (');
    expect(pageSource).toMatch(/value=\{contract\.supplier \|\| '[^']+'\}/);
    expect(pageSource).toMatch(/value=\{contract\.owner \|\| '[^']+'\}/);
    expect(pageSource).toContain('value={formatDate(contract.endDate)}');
    expect(pageSource).toContain('value={formatCurrency(contract.amount)}');
  });

  it('defines loading, retry, empty, unlinked, and unconfigured states', () => {
    expect(pageSource).toContain('正在加载框架合同数据');
    expect(pageSource).toContain('框架合同数据读取失败');
    expect(pageSource).toContain('重新加载');
    expect(pageSource).toContain('暂无框架合同');
    expect(pageSource).toContain('未找到匹配的框架合同');
    expect(pageSource).toContain('该框架合同尚未关联执行合同');
    expect(pageSource).toContain('框架合同数据源未配置');
    expect(pageSource).toMatch(
      /getContractSourceIssue\(dashboard\.sectionStatus, \[\s*'framework',\s*'contracts',\s*\]\)/,
    );
    expect(pageSource).toMatch(/relationshipSourceIssue\s*\?\s*\(/);
    expect(pageSource).toContain('框架合同关联数据暂不可用');
    expect(pageSource).toContain('{relationshipSourceIssue}');
  });

  it('keeps desktop and mobile lists responsive without a fixed wide canvas', () => {
    expect(pageSource).toContain('hidden lg:block');
    expect(pageSource).toContain('lg:hidden');
    expect(pageSource).toContain(
      'lg:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.28fr)]',
    );
    expect(pageSource).not.toMatch(/min-w-\[(?:8|9|1\d)\d{2}px\]/);
    expect(pageSource).toMatch(
      /<table\s+aria-labelledby="framework-list-title"/,
    );
  });

  it('selects and scrolls to the relationship region with reduced-motion support', () => {
    expect(pageSource).toContain('filterFrameworkContracts');
    expect(pageSource).toContain('selectInitialFrameworkId');
    expect(pageSource).toContain('relationshipRef');
    expect(pageSource).toContain('ref={relationshipRef}');
    expect(pageSource).toContain('scrollIntoView');
    expect(pageSource).toContain('prefers-reduced-motion: reduce');
  });

  it('derives a visible selection before persisting it after render', () => {
    expect(pageSource).toContain('const effectiveSelectedId =');
    expect(pageSource).toContain(
      'item.frameworkRecordId === effectiveSelectedId',
    );
    expect(pageSource).toContain('selectedId={effectiveSelectedId}');
    expect(pageSource).toMatch(
      /useEffect\(\(\) => \{\s*setSelectedId\(effectiveSelectedId\);\s*}, \[effectiveSelectedId\]\);/,
    );
    expect(pageSource).not.toContain('setSelectedId((current) => {');
  });

  it('reuses module-level number and date formatters', () => {
    const componentStart = pageSource.indexOf(
      'export default function FrameworkContractsPage()',
    );
    const moduleScope = pageSource.slice(0, componentStart);
    const componentScope = pageSource.slice(componentStart);

    expect(moduleScope.match(/new Intl\.NumberFormat/g)).toHaveLength(2);
    expect(moduleScope.match(/new Intl\.DateTimeFormat/g)).toHaveLength(2);
    expect(componentScope).not.toMatch(/new Intl\.(?:Number|DateTime)Format/);
    expect(pageSource).toContain('numberFormatter.format(value)');
    expect(pageSource).toContain('currencyFormatter.format(value)');
    expect(pageSource).toContain('dateFormatter.format(date)');
    expect(pageSource).toContain('updatedAtFormatter.format(date)');
  });

  it('stays outside attachment preview, payment difference, and OCR boundaries', () => {
    expect(pageSource).not.toContain('ContractAttachmentViewer');
    expect(pageSource).not.toContain('paymentDifferences');
    expect(pageSource).not.toContain('ContractPaymentDifference');
    expect(pageSource).not.toContain('rapidocr');
    expect(pageSource).not.toContain('CONTRACT_OCR_');
  });
});
