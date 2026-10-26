import * as fs from 'node:fs';
import * as path from 'node:path';

jest.mock('@/access/AccessProvider', () => ({ useAccess: jest.fn() }), {
  virtual: true,
});
jest.mock('@/api', () => ({}), { virtual: true });
jest.mock('@/components/ui/button', () => ({}), { virtual: true });
jest.mock('@/components/ui/input', () => ({}), { virtual: true });
jest.mock('@/lib/utils', () => ({ cn: jest.fn() }), { virtual: true });
jest.mock(
  '../../client/src/pages/PurchaseInventoryManagement/ManagementHeader',
  () => ({}),
);
jest.mock(
  '../../client/src/pages/ContractManagement/ContractAttachmentViewer',
  () => ({}),
);
jest.mock(
  '../../client/src/pages/ContractManagement/ContractExpiryDispositionDialog',
  () => ({}),
);
jest.mock(
  '../../client/src/pages/ContractManagement/ContractCreationDialog',
  () => ({}),
);
jest.mock(
  '../../client/src/pages/ContractManagement/ContractEditDialog',
  () => ({}),
);
jest.mock(
  '../../client/src/pages/ContractManagement/ContractMetricListDialog',
  () => ({}),
);
jest.mock(
  '../../client/src/pages/ContractManagement/ContractPaymentFollowUpDialog',
  () => ({}),
);
jest.mock(
  '../../client/src/pages/ContractManagement/SupplierDirectoryDialog',
  () => ({}),
);

import { buildContractListDisplay } from '../../client/src/pages/ContractManagement';
import { filterContracts } from '../../client/src/pages/ContractManagement/logic';
import type { ContractManagementItem } from '../../shared/contract-management.interface';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  expect(fs.existsSync(absolutePath)).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function createContractItem(
  recordId: string,
  name: string,
  status: ContractManagementItem['status'] = 'active',
): ContractManagementItem {
  return {
    recordId,
    name,
    code: recordId,
    amount: 0,
    contractType: '其他合同',
    specialty: '其他',
    supplier: '待补充',
    owner: '待补充',
    startDate: null,
    endDate: null,
    status,
    daysRemaining: null,
    expiryDisposition: '',
    paymentCycle: '',
    paymentRequirement: '',
    paymentProgress: {
      plannedAmount: 0,
      paidAmount: 0,
      completionRate: 0,
    },
    attachments: [],
  };
}

describe('contract management page', () => {
  it('hides unsigned contracts from the visible list while collapsed', () => {
    const signed = [createContractItem('signed-1', '已签订合同')];
    const unsigned = [createContractItem('unsigned-1', '未签订合同')];

    const display = buildContractListDisplay(signed, unsigned, false);

    expect(display.visibleContracts.map((item) => item.recordId)).toEqual([
      'signed-1',
    ]);
    expect(display.hiddenUnsignedCount).toBe(1);
  });

  it('appends unsigned contracts after signed contracts while expanded', () => {
    const signed = [
      createContractItem('signed-1', '已签订合同一'),
      createContractItem('signed-2', '已签订合同二'),
    ];
    const unsigned = [
      createContractItem('unsigned-1', '未签订合同一'),
      createContractItem('unsigned-2', '未签订合同二'),
    ];

    const display = buildContractListDisplay(signed, unsigned, true);

    expect(display.visibleContracts.map((item) => item.recordId)).toEqual([
      'signed-1',
      'signed-2',
      'unsigned-1',
      'unsigned-2',
    ]);
    expect(display.hiddenUnsignedCount).toBe(0);
  });

  it('filters signed and unsigned contracts before appending unsigned matches', () => {
    const signed = [
      createContractItem('signed-active', '空调维保', 'active'),
      createContractItem('signed-expired', '空调维保', 'expired'),
      createContractItem('signed-other', '消防维保', 'active'),
    ];
    const unsigned = [
      createContractItem('unsigned-active', '空调改造', 'active'),
      createContractItem('unsigned-expired', '空调采购', 'expired'),
      createContractItem('unsigned-other', '弱电采购', 'active'),
    ];

    const display = buildContractListDisplay(
      filterContracts(signed, 'active', '空调'),
      filterContracts(unsigned, 'active', '空调'),
      true,
    );

    expect(display.visibleContracts.map((item) => item.recordId)).toEqual([
      'signed-active',
      'unsigned-active',
    ]);
  });

  it('registers the contract route as an immersive management page', () => {
    const appSource = read('client/src/app.tsx');
    const layoutSource = read('client/src/components/Layout.tsx');

    expect(appSource).toContain('path="/contract-management"');
    expect(appSource).toContain('<ContractManagementPage />');
    expect(layoutSource).toContain("pathname === '/contract-management'");
  });

  it('uses the shared 采‑供‑存 command header and global navigation shell', () => {
    const headerSource = read(
      'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
    );
    const navigationSource = read('client/src/components/GlobalNavigation.tsx');
    const registrySource = read('client/src/navigation/page-switcher.ts');

    expect(headerSource).toContain('南通全景运维平台 · 采‑供‑存');
    expect(headerSource).not.toContain('<nav');
    expect(headerSource).not.toContain('managementTabs');
    expect(headerSource).toContain('activePage: ManagementPageKey;');
    expect(headerSource).toContain('actions?: ReactNode;');
    expect(headerSource).toContain('updatedAt: string;');
    expect(headerSource).toContain('onFilter?: () => void;');
    expect(headerSource).toContain('role="toolbar"');
    expect(headerSource).toContain("toolbarLabel = '供应链页面工具栏'");
    expect(headerSource).toContain('aria-label={toolbarLabel}');
    expect(headerSource).toContain('<Search');
    expect(headerSource).toContain('onClick={onFilter}');
    expect(headerSource).not.toContain('PageSwitcher');
    expect(headerSource).not.toContain('UnifiedAccessControl');
    expect(headerSource).toContain('{actions}');
    expect(headerSource).toContain('{updatedAt}');
    expect(navigationSource).toContain('getAccessibleNavigationDomains(role, pagePaths)');
    expect(navigationSource).toContain(
      "aria-current={active ? 'page' : undefined}",
    );
    expect(registrySource).toContain("label: '采‑供‑存'");
    expect(registrySource).toContain("label: '合同管理'");
    expect(registrySource).toContain("path: '/contract-management'");
  });

  it('passes contract context into the shared header in both workspaces', () => {
    const headerSource = read(
      'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
    );
    const pageSource = read('client/src/pages/ContractManagement/index.tsx');
    const frameworkPageSource = read(
      'client/src/pages/ContractManagement/FrameworkContractsPage.tsx',
    );
    const pageHeaderUsage = pageSource.slice(
      pageSource.indexOf('<ManagementHeader'),
      pageSource.indexOf('<main'),
    );
    const frameworkHeaderUsage = frameworkPageSource.slice(
      frameworkPageSource.indexOf('<ManagementHeader'),
      frameworkPageSource.indexOf('<main'),
    );

    expect(headerSource).not.toContain("from './ManagementPageSwitcher';");
    expect(headerSource).toContain('type ManagementPageKey =');
    expect(headerSource).toContain("| 'contract'");
    expect(headerSource).toContain("| 'monthly-report'");
    expect(pageSource).not.toContain(
      "import { ManagementPageSwitcher } from '../PurchaseInventoryManagement/ManagementPageSwitcher';",
    );
    expect(frameworkPageSource).not.toContain(
      "import { ManagementPageSwitcher } from '../PurchaseInventoryManagement/ManagementPageSwitcher';",
    );
    expect(pageHeaderUsage).toContain('activePage="contract"');
    expect(pageHeaderUsage).toContain('updatedAt=');
    expect(pageHeaderUsage).toContain('onFilter=');
    expect(pageHeaderUsage).toContain('actions=');
    expect(frameworkHeaderUsage).toContain('activePage="contract"');
    expect(frameworkHeaderUsage).toContain('updatedAt=');
    expect(pageSource).not.toContain('<ManagementPageSwitcher');
    expect(frameworkPageSource).not.toContain('<ManagementPageSwitcher');
  });

  it('renders a live-data contract workspace with operational states', () => {
    const pageSource = read('client/src/pages/ContractManagement/index.tsx');

    expect(pageSource).toContain('getContractManagementDashboard');
    expect(pageSource).toContain("import { Link } from 'react-router-dom';");
    expect(pageSource).toContain("label: '框架合同'");
    expect(pageSource).toContain("label: '执行合同'");
    expect(pageSource).toContain('即将到期');
    expect(pageSource).toContain('履约中合同总金额');
    expect(pageSource).toContain('合同金额与类型概览');
    expect(pageSource).toContain('合同付款情况');
    expect(pageSource).toContain('合同到期风险');
    expect(pageSource).toContain('付款计划重点跟进');
    expect(pageSource).toContain('待补付款计划');
    expect(pageSource).toContain('合同执行清单');
    expect(pageSource).toContain("{ key: 'expired', label: '已失效' }");
    expect(pageSource).not.toContain("{ key: 'pending', label: '未生效' }");
    expect(pageSource).toContain('付款性质');
    expect(pageSource).not.toContain('items.slice(0, 12)');
    expect(pageSource).toContain('loading');
    expect(pageSource).toContain('loadError');
    expect(pageSource).toContain('暂无合同数据');
    expect(pageSource).toContain(
      'className="flex h-full min-w-0 flex-col rounded-lg border border-slate-200 bg-white p-5 shadow-sm"',
    );
    expect(pageSource).toContain(
      "import { createLatestRequestCoordinator } from './latest-request';",
    );
    expect(pageSource).toContain(
      'const [requestCoordinator] = useState(createLatestRequestCoordinator);',
    );
    expect(pageSource).toContain('await requestCoordinator.run(');
    expect(pageSource).toContain('requestCoordinator.invalidate();');
  });

  it('shows every desktop contract column without a horizontally scrolling table', () => {
    const pageSource = read('client/src/pages/ContractManagement/index.tsx');
    const headerSource = read(
      'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
    );
    const contractHeaderUsage = pageSource.slice(
      pageSource.indexOf('<ManagementHeader'),
      pageSource.indexOf('/>', pageSource.indexOf('<ManagementHeader')) + 2,
    );
    const contractListSource = pageSource.slice(
      pageSource.indexOf('function ContractList'),
      pageSource.indexOf('function ContractPaymentProgress'),
    );

    expect(contractHeaderUsage).toContain('showSearch');
    expect(contractHeaderUsage).toContain('searchResults=');
    expect(pageSource).toContain('ContractQuickSearchResults');
    expect(pageSource).toContain('onLocate={handleLocateContract}');
    expect(pageSource).toContain('setQuickViewerRequest(request);');
    expect(headerSource).toContain('showSearch?: boolean;');
    expect(headerSource).toContain('showSearch && onSearchChange && (');
    expect(contractListSource).not.toContain('value={searchQuery}');
    expect(contractListSource).toContain(
      'data-contract-record-id={item.recordId}',
    );
    expect(contractListSource).not.toContain('付款要求');
    expect(contractListSource).not.toContain('min-w-[1580px]');
    expect(contractListSource).toContain(
      '<table className="w-full table-fixed',
    );
    expect(contractListSource).toContain('<colgroup>');
    expect(contractListSource).toContain('信息迭代');
    expect(contractListSource).toContain('ContractEditDialog');
    expect(contractListSource).toContain('canManageContracts');
    expect(pageSource).toContain('dashboard?.unsignedContracts ?? []');
    expect(pageSource).toContain(
      'unsignedContracts={filteredUnsignedContracts}',
    );
    expect(contractListSource).toContain(
      'const [unsignedExpanded, setUnsignedExpanded] = useState(false);',
    );
    expect(contractListSource).toContain(
      '未签订合同（{unsignedContracts.length}）',
    );
    expect(contractListSource).toContain('aria-expanded={unsignedExpanded}');
    expect(contractListSource).toContain(
      'onClick={() => setUnsignedExpanded((expanded) => !expanded)}',
    );
    expect(contractListSource).toContain("unsignedExpanded && 'rotate-180'");
    expect(contractListSource).toContain('buildContractListDisplay(');
    expect(
      contractListSource.match(
        /unsignedExpanded && index === contracts\.length/g,
      ),
    ).toHaveLength(2);
    expect(
      contractListSource.match(
        /!unsignedExpanded && unsignedContracts\.length > 0/g,
      ),
    ).toHaveLength(2);
    expect(contractListSource).toContain('份未签订合同已收起');
  });

  it('keeps contract search results visible beyond the management header boundary', () => {
    const headerSource = read(
      'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
    );

    expect(headerSource).toContain(
      "'relative z-30 overflow-visible text-white'",
    );
    expect(headerSource).toContain('data-management-header-effects="true"');
    expect(headerSource).toContain(
      'className="pointer-events-none absolute inset-0 overflow-hidden"',
    );
    expect(headerSource).not.toContain("'relative overflow-hidden text-white'");
  });

  it('uses contract counts in the overview and links frameworks to their workspace', () => {
    const pageSource = read('client/src/pages/ContractManagement/index.tsx');
    const metricListSource = read(
      'client/src/pages/ContractManagement/ContractMetricListDialog.tsx',
    );
    const metricsSource = pageSource.slice(
      pageSource.indexOf('function ContractMetrics'),
      pageSource.indexOf('function ContractAmountTop5Panel'),
    );
    const frameworkButtonSource = metricsSource.slice(
      metricsSource.indexOf('<Link'),
      metricsSource.indexOf('</Link>') + '</Link>'.length,
    );
    const staticCardsSource = metricsSource.slice(
      metricsSource.indexOf('const cards: MetricCard[]'),
      metricsSource.indexOf('return ('),
    );
    const cardsRenderSource = metricsSource.slice(
      metricsSource.indexOf('{cards.map('),
      metricsSource.lastIndexOf('</section>'),
    );
    const metricsGridStart = metricsSource.indexOf(
      '<section',
      metricsSource.indexOf('return ('),
    );
    const metricsGridEnd = metricsSource.lastIndexOf('</section>');
    const metricsGridSource =
      metricsGridStart >= 0 && metricsGridEnd > metricsGridStart
        ? metricsSource.slice(metricsGridStart, metricsGridEnd)
        : '';
    const cardsMapStart = metricsGridSource.indexOf('{cards.map(');
    const cardsMapEnd = metricsGridSource.indexOf('))}', cardsMapStart);
    const directPeerMetricSource =
      cardsMapEnd >= 0
        ? metricsGridSource.slice(cardsMapEnd + '))}'.length).trim()
        : '';
    const metricListDialogUsage =
      directPeerMetricSource.match(
        /<ContractMetricListDialog\b[\s\S]*?\/>/,
      )?.[0] ?? '';
    const supplierDialogUsage =
      directPeerMetricSource.match(
        /<SupplierDirectoryDialog\b[\s\S]*?\/>/,
      )?.[0] ?? '';
    const pendingPaymentStart = staticCardsSource.indexOf(
      "key: 'pendingPayment'",
    );
    const pendingPaymentEnd = staticCardsSource.indexOf(
      '\n    },',
      pendingPaymentStart,
    );
    const pendingPaymentSource =
      pendingPaymentStart >= 0 && pendingPaymentEnd > pendingPaymentStart
        ? staticCardsSource.slice(pendingPaymentStart, pendingPaymentEnd)
        : '';

    expect(metricsSource.match(/label: '[^']+'/g)).toEqual([
      "label: '框架合同'",
      "label: '执行合同'",
      "label: '即将到期'",
      "label: '履约中合同总金额'",
    ]);
    expect(metricsSource).toContain('summary.activeFrameworkContracts');
    expect(metricsSource).not.toContain('summary.frameworkContracts');
    expect(metricsSource).not.toContain(
      'dashboard.frameworkRelations.summary.unlinkedFrameworks',
    );
    expect(metricsSource).not.toContain('summary.totalContracts');
    expect(metricsSource).toContain(
      'summary.activeContracts + summary.expiringContracts',
    );
    expect(metricsSource).not.toContain(
      'dashboard.frameworkRelations.summary.linkedExecutionContracts',
    );
    expect(metricsSource).toContain('仅统计有效框架合同');
    expect(metricsSource).toContain('仅统计有效及执行中合同');
    expect(metricsSource).toContain('summary.expiringContracts');
    expect(metricsSource).toContain(
      'sumActiveContractValue(dashboard.contracts)',
    );
    expect(metricsSource.match(/<Link\b/g)).toHaveLength(1);
    expect(metricsSource.match(/\bto=/g)).toHaveLength(1);
    expect(metricsSource.match(/\bonClick=/g) ?? []).toHaveLength(1);
    expect(metricsSource).toContain('xl:grid-cols-5');
    expect(metricsSource).toContain('{frameworkCard.label}');
    expect(metricsSource).toContain('to="/contract-management/frameworks"');
    expect(frameworkButtonSource).toContain(
      'aria-label="查看框架合同关联详情"',
    );
    expect(frameworkButtonSource).toContain('focus-visible:');
    expect(frameworkButtonSource).toContain(
      'to="/contract-management/frameworks"',
    );
    expect(frameworkButtonSource).toContain('<ArrowRight');
    expect(staticCardsSource.match(/label: '[^']+'/g)).toEqual([
      "label: '执行合同'",
      "label: '即将到期'",
      "label: '履约中合同总金额'",
    ]);
    expect(metricsSource).toMatch(
      /type MetricCard = \{[\s\S]*?\bkey:\s*[^;]+;/,
    );
    expect(staticCardsSource).toContain("key: 'pendingPayment'");
    expect(metricsSource).toMatch(/\{cards\.map\([\s\S]*?<button/);
    expect(metricsSource).toContain('key={key}');
    expect(metricsSource).toContain('onClick={() => setMetricListKind(key)}');
    expect(metricsSource).toContain('aria-label={`查看${label}清单`}');
    expect(metricsSource).toContain('id={`contract-metric-${key}`}');
    expect(metricsSource).toContain(
      'const [metricListKind, setMetricListKind]',
    );
    expect(metricsSource).toContain('<ContractMetricListDialog');
    expect(metricsSource).toContain('kind={metricListKind}');
    expect(cardsMapStart).toBeGreaterThanOrEqual(0);
    expect(cardsMapEnd).toBeGreaterThan(cardsMapStart);
    expect(directPeerMetricSource.startsWith('<ContractMetricListDialog')).toBe(
      true,
    );
    expect(metricListDialogUsage).toContain('<ContractMetricListDialog');
    expect(metricListDialogUsage).toContain('dashboard={dashboard}');
    expect(metricListDialogUsage).toContain('kind={metricListKind}');
    expect(metricListDialogUsage).toContain('onOpenChange={setMetricListKind}');
    expect(supplierDialogUsage).toContain('<SupplierDirectoryDialog');
    expect(supplierDialogUsage).toContain(
      'directory={dashboard.supplierDirectory}',
    );
    expect(supplierDialogUsage).toContain('sourceIssue={supplierSourceIssue}');
    expect(
      metricsGridSource.match(/<SupplierDirectoryDialog\b/g) ?? [],
    ).toHaveLength(1);
    expect(cardsRenderSource).not.toContain("key === 'pendingPayment'");
    expect(pendingPaymentSource).toContain('summary.overduePayments');
    expect(pendingPaymentSource).not.toContain('supplierSourceIssue');
    expect(pendingPaymentSource).not.toContain('summary.supplierCount');
    expect(pendingPaymentSource).not.toContain('supplierDirectory');
    expect(pendingPaymentSource).not.toContain('供应商');
    expect(directPeerMetricSource).not.toContain("key === 'pendingPayment'");
    expect(pageSource).not.toContain('合同资产总额');
    expect(pageSource).not.toContain('<FrameworkRelationPanel');
    expect(pageSource).not.toContain('function FrameworkRelationPanel');
    expect(pageSource).not.toContain('function RelationMetric');
    expect(metricsSource).toMatch(
      /getContractSourceIssue\(\s*dashboard\.sectionStatus,\s*\[\s*'contracts',?\s*\],?\s*\)/,
    );
    expect(metricsSource).toMatch(/value:\s*contractSourceIssue\s*\?\s*'--'/);
    expect(metricsSource).toContain('付款计划数据暂不可用');
    expect(metricsSource).not.toContain(
      'countExpiredContractsInGeneratedMonth(',
    );
    expect(metricsSource).not.toContain('本月失效');
    expect(pageSource).toContain('subtitle="未来 60 天内即将到期"');
    expect(pageSource).not.toContain('已到期 30 天内');
    expect(metricListSource).toContain(
      "item.status === 'active' || item.status === 'expiring'",
    );
    expect(metricListSource).toContain(
      '仅展示当前有效、正在执行及未来 60 天内到期的合同。',
    );
    expect(metricListSource).not.toContain(
      '展示当前已同步的全部执行合同明细。',
    );
  });

  it('renders compact contract amount and type charts plus a split payment trend', () => {
    const pageSource = read('client/src/pages/ContractManagement/index.tsx');
    const topContractsSource = pageSource.slice(
      pageSource.indexOf('function ContractAmountTop5Panel'),
      pageSource.indexOf('function PaymentProgress'),
    );
    const paymentProgressSource = pageSource.slice(
      pageSource.indexOf('function PaymentProgress'),
      pageSource.indexOf('function PaymentPeriodRing'),
    );
    const paymentTrendSource = pageSource.slice(
      pageSource.indexOf('function PaymentMonthlyAreaTrend'),
      pageSource.indexOf('function PaymentTrendTooltip'),
    );
    const paymentTrendTooltipSource = pageSource.slice(
      pageSource.indexOf('function PaymentTrendTooltip'),
      pageSource.indexOf('function PaymentPeriodRing'),
    );

    expect(pageSource).toContain('typeBreakdown={dashboard.typeBreakdown}');
    expect(topContractsSource).toContain('title="合同金额与类型概览"');
    expect(topContractsSource).toContain('合同金额 TOP5');
    expect(topContractsSource).toContain('合同类型分布');
    expect(topContractsSource).toContain(
      'getTopActiveContractsByAmount(contracts)',
    );
    expect(topContractsSource).toContain('function ContractAmountRanking');
    expect(topContractsSource).toContain('function ContractTypeDonut');
    expect(topContractsSource).toContain('<PieChart');
    expect(topContractsSource).not.toContain('layout="vertical"');
    expect(topContractsSource).not.toContain('<BarChart');
    expect(paymentProgressSource).toContain('buildPaymentPlanMonthlyTrend(');
    expect(paymentProgressSource).toContain('<PaymentMonthlyAreaTrend');
    expect(paymentTrendSource).toContain('<AreaChart');
    expect(paymentTrendSource).toContain('<ReferenceLine');
    expect(paymentTrendSource).toContain('historyAmount');
    expect(paymentTrendSource).toContain('futureAmount');
    expect(paymentTrendSource).toContain('合同付款趋势');
    expect(paymentTrendSource).toContain(
      '近 3 个月按实际已付款 · 本月及未来 3 个月按计划付款',
    );
    expect(paymentTrendSource).toContain('历史实际付款金额');
    expect(paymentTrendSource).toContain('本月及未来计划金额');
    expect(paymentTrendTooltipSource).toContain(
      "item.basis === 'actual' ? '实际付款' : '计划付款'",
    );
    expect(paymentTrendSource).not.toContain('付款计划趋势');
    expect(paymentTrendSource).toContain('className="h-44 min-w-0"');
    expect(paymentTrendSource).not.toContain('<CartesianGrid');
    expect(paymentTrendSource.match(/<Area\b/g)).toHaveLength(2);
    expect(pageSource).toContain(
      'className="grid items-stretch gap-5 xl:grid-cols-2"',
    );
  });

  it('upgrades the payment metric dialog to charts and two-level groups', () => {
    const metricListSource = read(
      'client/src/pages/ContractManagement/ContractMetricListDialog.tsx',
    );

    expect(metricListSource).toContain("title: '付款执行分析'");
    expect(metricListSource).toContain(
      'buildPendingPaymentAnalytics(dashboard.payments)',
    );
    expect(metricListSource).toContain('按计划付款年度');
    expect(metricListSource).toContain('逾期结构');
    expect(metricListSource).toContain('<BarChart');
    expect(metricListSource).toContain('<PieChart');
    expect(metricListSource).toContain('analytics.groups.map');
    expect(metricListSource).toContain('group.sections.map');
    expect(metricListSource).toContain('日期待补充');
  });

  it('suppresses every payment conclusion when the payment source failed', () => {
    const pageSource = read('client/src/pages/ContractManagement/index.tsx');
    const paymentProgressSource = pageSource.slice(
      pageSource.indexOf('function PaymentProgress'),
      pageSource.indexOf('function PaymentPeriodRing'),
    );
    const paymentAttentionSource = pageSource.slice(
      pageSource.indexOf('function PaymentAttentionPanel'),
      pageSource.indexOf('function PaymentAttentionBadge'),
    );
    const missingPaymentPlanSource = pageSource.slice(
      pageSource.indexOf('function MissingPaymentPlanPanel'),
      pageSource.indexOf('function PaymentFollowUpMetric'),
    );
    const contractListSource = pageSource.slice(
      pageSource.indexOf('function ContractList'),
      pageSource.indexOf('function Panel'),
    );

    expect(pageSource).toContain(
      "const paymentSourceIssue = dashboard\n    ? getContractSourceIssue(dashboard.sectionStatus, ['payments'])",
    );
    expect(pageSource).toMatch(
      /<PaymentProgress\s+dashboard=\{dashboard\}\s+sourceIssue=\{paymentSourceIssue\}\s+\/>/,
    );
    expect(pageSource).toContain('<PaymentAttentionPanel');
    expect(pageSource).toContain('<MissingPaymentPlanPanel');
    expect(pageSource).toContain('paymentSourceIssue={paymentSourceIssue}');
    expect(paymentProgressSource).toContain('sourceIssue: string | null');
    expect(paymentProgressSource).toContain('付款统计数据暂不可用');
    expect(paymentProgressSource).toContain('{sourceIssue}');
    expect(paymentAttentionSource).toMatch(
      /getContractSourceIssue\(dashboard\.sectionStatus, \[\s*'contracts',\s*'payments',\s*\]\)/,
    );
    expect(paymentAttentionSource).toContain('付款计划跟进数据暂不可用');
    expect(paymentAttentionSource).toContain('{dataSourceIssue ? (');
    expect(missingPaymentPlanSource).toMatch(
      /getContractSourceIssue\(dashboard\.sectionStatus, \[\s*'contracts',\s*'payments',\s*\]\)/,
    );
    expect(missingPaymentPlanSource).toContain('付款计划关联数据暂不可用');
    expect(contractListSource).toContain('paymentSourceIssue: string | null');
    expect(
      contractListSource.match(
        /<ContractPaymentProgress\s+item=\{item\}\s+sourceIssue=\{paymentSourceIssue\}\s+\/>/g,
      ),
    ).toHaveLength(2);
    expect(contractListSource).toContain('付款进度数据暂不可用');
  });
});
