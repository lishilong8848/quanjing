import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readIfPresent(relativePath: string): string | null {
  const absolutePath = join(root, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
}

describe('contract supplier directory UI', () => {
  it('renders the supplier directory dialog with the metric dialogs as peer content', () => {
    const page = readFileSync(
      join(root, 'client/src/pages/ContractManagement/index.tsx'),
      'utf8',
    );

    expect(page).toContain(
      "import { SupplierDirectoryDialog } from './SupplierDirectoryDialog';",
    );
    const supplierDialogUsage =
      page.match(/<SupplierDirectoryDialog\b[\s\S]*?\/>/)?.[0] ?? '';
    const metricsSource = page.slice(
      page.indexOf('function ContractMetrics'),
      page.indexOf('function ContractAmountTop5Panel'),
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
    const cardsMapEnd = metricsGridSource.indexOf(
      '))}',
      metricsGridSource.indexOf('{cards.map('),
    );
    const directPeerMetricSource =
      cardsMapEnd >= 0
        ? metricsGridSource.slice(cardsMapEnd + '))}'.length).trim()
        : '';

    expect(metricsGridSource).toContain('xl:grid-cols-5');
    expect(directPeerMetricSource).toContain('<ContractMetricListDialog');
    expect(directPeerMetricSource).toContain('<SupplierDirectoryDialog');
    expect(
      directPeerMetricSource.indexOf('<SupplierDirectoryDialog'),
    ).toBeGreaterThan(
      directPeerMetricSource.indexOf('<ContractMetricListDialog'),
    );
    expect(directPeerMetricSource.endsWith('/>')).toBe(true);
    expect(directPeerMetricSource).not.toContain('<article');
    expect(supplierDialogUsage).toContain('<SupplierDirectoryDialog');
    expect(supplierDialogUsage).toContain(
      'directory={dashboard.supplierDirectory}',
    );
    expect(supplierDialogUsage).toContain('sourceIssue={supplierSourceIssue}');
    expect(page).not.toMatch(/<SupplierDirectoryPanel\b/);
  });

  it('defines an accessible responsive supplier directory dialog', () => {
    const dialog = readIfPresent(
      'client/src/pages/ContractManagement/SupplierDirectoryDialog.tsx',
    );

    expect(dialog ?? 'dialog file missing').not.toBe('dialog file missing');
    if (dialog === null) return;

    const triggerSource =
      dialog.match(/<DialogTrigger\b[\s\S]*?<\/DialogTrigger>/)?.[0] ?? '';
    const triggerButtonStart = triggerSource.indexOf('<button');
    const triggerButtonEnd = triggerSource.indexOf('>', triggerButtonStart);
    const triggerButtonOpening =
      triggerButtonStart >= 0 && triggerButtonEnd > triggerButtonStart
        ? triggerSource.slice(triggerButtonStart, triggerButtonEnd + 1)
        : '';
    const contentSource =
      dialog.match(/<DialogContent\b[\s\S]*?<\/DialogContent>/)?.[0] ?? '';
    const closeSource =
      contentSource.match(/<DialogClose\b[\s\S]*?<\/DialogClose>/)?.[0] ?? '';
    const sourceIssueBranches = contentSource.match(
      /\{sourceIssue\s*\?\s*\(([\s\S]*?)\)\s*:\s*\(([\s\S]*?)\)\s*\}/,
    );
    const sourceIssueErrorBranch = sourceIssueBranches?.[1] ?? '';
    const sourceIssueHealthyBranch = sourceIssueBranches?.[2] ?? '';
    const panelUsage =
      sourceIssueHealthyBranch.match(
        /<SupplierDirectoryPanel\b[\s\S]*?\/>/,
      )?.[0] ?? '';
    const scrollRegionOpeningTag =
      contentSource.match(/<[^>]*\boverflow-y-auto\b[^>]*>/)?.[0] ?? '';

    expect(dialog).toMatch(/sourceIssue\??:\s*string\s*\|\s*null/);
    expect(triggerSource).toMatch(/<DialogTrigger\b[^>]*\basChild\b[^>]*>/);
    expect(triggerButtonOpening).toContain('w-full');
    expect(triggerButtonOpening).toContain('h-full');
    expect(triggerButtonOpening).toContain('text-left');
    expect(triggerButtonOpening).not.toContain('w-20');
    expect(triggerButtonOpening).not.toContain('2xl:w-28');
    expect(triggerButtonOpening).not.toContain('text-center');
    expect(triggerSource).toContain('<Building2');
    expect(triggerSource).toContain('供应商名录');
    expect(triggerSource).toContain('<ArrowRight');
    expect(triggerSource).toMatch(
      /\{\s*sourceIssue\s*\?\s*['"]--['"]\s*:\s*`\$\{\s*formatNumber\(\s*summary\.totalSuppliers\s*\)\s*\}\s+家`\s*\}/,
    );
    expect(contentSource).toContain('<DialogContent');
    expect(contentSource).toMatch(/showCloseButton\s*=\s*\{false\}/);
    expect(contentSource).toMatch(
      /<DialogTitle(?:\s[^>]*)?>\s*供应商名录\s*<\/DialogTitle>/,
    );
    expect(contentSource).toMatch(
      /<DialogDescription\b[\s\S]*?<\/DialogDescription>/,
    );
    expect(closeSource).toContain('<DialogClose');
    expect(closeSource).toMatch(/aria-label=["']关闭供应商名录["']/);
    expect(sourceIssueBranches).not.toBeNull();
    expect(sourceIssueErrorBranch).toMatch(/role=["']alert["']/);
    expect(sourceIssueErrorBranch).not.toContain('<SupplierDirectoryPanel');
    expect(sourceIssueHealthyBranch).not.toMatch(/role=["']alert["']/);
    expect(contentSource.match(/role=["']alert["']/g) ?? []).toHaveLength(1);
    expect(
      contentSource.match(/<SupplierDirectoryPanel\b/g) ?? [],
    ).toHaveLength(1);
    expect(panelUsage).toContain('<SupplierDirectoryPanel');
    expect(panelUsage).toContain('directory={directory}');
    expect(panelUsage).toMatch(
      /(?:^|\s)(?:embedded(?!\s*=)|embedded\s*=\s*\{true\})(?=\s|\/?>)/m,
    );
    expect(contentSource.match(/\boverflow-(?:x-|y-)?auto\b/g) ?? []).toEqual([
      'overflow-y-auto',
    ]);
    expect(scrollRegionOpeningTag).toMatch(/\boverscroll-contain\b/);
    expect(contentSource).toContain('h-[100dvh]');
    expect(contentSource).toContain('sm:max-w-[1440px]');
  });

  it('keeps supplier search, four metrics, and responsive panel layouts', () => {
    const panel = readFileSync(
      join(
        root,
        'client/src/pages/ContractManagement/SupplierDirectoryPanel.tsx',
      ),
      'utf8',
    );

    expect(panel).toContain('供应商名录');
    expect(panel).toContain('名录公司');
    expect(panel).toContain('联系人记录');
    expect(panel).toContain('关联合同');
    expect(panel).toContain('联系电话完整度');
    expect(panel).toContain('搜索公司、联系人、电话、园区对接人或合同');
    expect(panel).toContain('联系电话完整显示');
    expect(panel).not.toContain('联系电话已脱敏显示');
    expect(panel).toContain('lg:hidden');
    expect(panel).toContain('hidden lg:block');
    expect(panel).toContain('供应商合作深度');
    expect(panel).toContain('＞10万');
    expect(panel).toContain('5万–10万');
    expect(panel).toContain('＜5万');
    expect(panel).toContain('item.cooperationDepth');
    expect(panel).toContain('function SupplierContractListDialog');
    expect(panel).toContain('查看关联合同');
    expect(panel).toContain('contract.startDate');
    expect(panel).toContain('contract.endDate');
    expect(panel).toContain('合同周期');
    expect(panel).toContain('<DialogContent');
    expect(panel).not.toContain('打开多维表');
  });
});
