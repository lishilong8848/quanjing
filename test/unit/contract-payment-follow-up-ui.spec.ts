import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

function readPageSource(): string {
  return fs.readFileSync(
    path.join(root, 'client/src/pages/ContractManagement/index.tsx'),
    'utf8',
  );
}

function extractFunction(
  pageSource: string,
  start: string,
  end: string,
): string {
  return pageSource.slice(pageSource.indexOf(start), pageSource.indexOf(end));
}

describe('contract payment attention UI', () => {
  it('将付款节点与重点跟进合并为一张双标签卡片', () => {
    const pageSource = readPageSource();
    const panelSource = extractFunction(
      pageSource,
      'function PaymentAttentionPanel',
      'function PaymentAttentionBadge',
    );

    expect(panelSource).toContain('title="付款计划重点跟进"');
    expect(panelSource).toContain('到期未付款');
    expect(panelSource).toContain('30 天内需付款');
    expect(panelSource).toContain('partitionPaymentAttentionItems(');
    expect(panelSource).toContain('dashboard.paymentRisks');
    expect(panelSource).toContain("useState<PaymentAttentionTab>('overdue')");
    expect(panelSource).toContain('aria-pressed={activeTab === tab.key}');
    expect(panelSource).not.toContain('role="tablist"');
    expect(panelSource).not.toContain('role="tab"');
    expect(panelSource).toContain('item.dueDate');
    expect(panelSource).toContain('计划付款日期');
    expect(panelSource).toContain('ContractPaymentFollowUpDialog');
    expect(panelSource).toContain('setPaymentTarget(target)');
    expect(pageSource).not.toContain('function PaymentRiskPanel');
    expect(pageSource).not.toContain('function PaymentFollowUpPanel');
  });

  it('付款重点卡片在合同或付款数据失败时不误报空状态', () => {
    const panelSource = extractFunction(
      readPageSource(),
      'function PaymentAttentionPanel',
      'function PaymentAttentionBadge',
    );

    expect(panelSource).toMatch(
      /getContractSourceIssue\(dashboard\.sectionStatus, \[\s*'contracts',\s*'payments',\s*\]\)/,
    );
    expect(panelSource).toContain("dataSourceIssue ? '数据异常'");
    expect(panelSource).toContain('{dataSourceIssue ? (');
    expect(panelSource).toContain('付款计划跟进数据暂不可用');
    expect(panelSource).toContain('{dataSourceIssue}');
  });

  it('新增待补付款计划卡片并明确合同编号关联已配置', () => {
    const pageSource = readPageSource();
    const panelSource = extractFunction(
      pageSource,
      'function MissingPaymentPlanPanel',
      'function ContractList',
    );

    expect(panelSource).toContain('title="待补付款计划"');
    expect(panelSource).toContain(
      '付款计划表已配置合同编号关联；以下合同暂无对应付款计划记录',
    );
    expect(panelSource).toContain('findContractsWithoutPaymentPlans(');
    expect(panelSource).toContain('buildPaymentFollowUpTarget(');
    expect(panelSource).toContain('ContractPaymentFollowUpDialog');
    expect(panelSource).toContain('新增付款计划');
    expect(panelSource).toContain('合同结束日期');
    expect(panelSource).toContain('MISSING_PAYMENT_PLAN_PAGE_SIZE');
    expect(pageSource).toContain('const MISSING_PAYMENT_PLAN_PAGE_SIZE = 6;');
    expect(panelSource).toMatch(/paginateItems\(\s*items,\s*page,/);
    expect(panelSource).toContain('上一页');
    expect(panelSource).toContain('下一页');
    expect(panelSource).toContain(": '暂无'");
    expect(panelSource).toContain(
      '<InlineEmpty label="暂无待补付款计划" success />',
    );
    expect(panelSource).toContain('canManageContracts');
    expect(panelSource).toContain('<span>合同名称</span>');
    expect(panelSource).toContain('lg:h-[72px]');
    expect(panelSource).not.toContain('item.contractCode');
    expect(panelSource).not.toContain('编号待补充');
    expect(panelSource).not.toContain('跟进人：{item.owner}');
    expect(panelSource).not.toContain(
      '付款计划多维表没有关联条目，请补录并确认付款责任。',
    );
    expect(panelSource).not.toContain('付款概况');
    expect(panelSource).not.toContain('PaymentFollowUpMetric');
    expect(panelSource).not.toContain('合同已于');
    expect(panelSource).toContain('暂无待补付款计划');
    expect(panelSource).toMatch(
      /getContractSourceIssue\(dashboard\.sectionStatus, \[\s*'contracts',\s*'payments',\s*\]\)/,
    );
    expect(panelSource).toContain('付款计划关联数据暂不可用');
    expect(panelSource).not.toContain(
      '尚未在付款计划多维表关联任何条目的合同',
    );
    expect(panelSource).not.toContain('无付款条目');
  });

  it('keeps the paired payment cards equal height', () => {
    const pageSource = readPageSource();
    const panelSource = extractFunction(
      pageSource,
      'function Panel',
      'function StatusBadge',
    );

    expect(panelSource).toContain('flex h-full min-w-0 flex-col');
    expect(panelSource).toContain('min-h-0 flex-1');
  });

  it('将合同金额 TOP5 与到期风险并排，付款情况与无计划并排', () => {
    const pageSource = readPageSource();
    const dashboardLayout = pageSource.slice(
      pageSource.indexOf('<ContractMetrics dashboard={dashboard} />'),
      pageSource.indexOf('<ContractList'),
    );

    expect(dashboardLayout).toMatch(
      /<section className="grid items-stretch gap-5 xl:grid-cols-2">[\s\S]*?<ContractAmountTop5Panel[\s\S]*?<ContractRiskPanel[\s\S]*?<\/section>/,
    );
    expect(dashboardLayout).toMatch(
      /<PaymentAttentionPanel[\s\S]*?<section className="grid items-stretch gap-5 xl:grid-cols-2">[\s\S]*?<PaymentProgress[\s\S]*?<MissingPaymentPlanPanel[\s\S]*?<\/section>/,
    );
  });
});
