import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('purchase completion analysis UI', () => {
  it('opens completion analysis from the merged overview cards', () => {
    const source = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(source).toContain("label: '采购申请阶段'");
    expect(source).toContain("label: '采购完成'");
    expect(source).toContain('stageCounts.application');
    expect(source).toContain('stageCounts.approval');
    expect(source).toContain('setCompletionDialogOpen(true)');
    expect(source).toContain('<PurchaseCompletionAnalysisDialog');
  });

  it('provides source-backed yearly and multi-dimensional analysis', () => {
    const source = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseCompletionAnalysisDialog.tsx',
    );

    expect(source).toContain('采购完成分析');
    expect(source).toContain('本年月度采购趋势');
    expect(source).toContain('ComposedChart');
    expect(source).toContain('完成采购分类分析');
    expect(source).toContain('楼栋采购分布');
    expect(source).toContain('供应商采购排行');
    expect(source).toContain('完成采购明细');
    expect(source).toContain('采购单号');
    expect(source).toContain('规格型号');
    expect(source).toContain("item.specification || '未填写'");
    expect(source).toContain('groupPurchaseOrderItems');
    expect(source).toContain('rowSpan={rowSpan}');
    expect(source).toContain('buildPurchaseCompletionAnalysis');
    expect(source).toContain("transform: 'translate(-50%, -50%)'");
    expect(source).toContain("translate: 'none'");
    expect(source).toContain('!animate-none');
    expect(source).toContain('max-sm:!h-screen');
    expect(source).toContain('className="min-w-0 w-full overflow-y-auto"');
    expect(source).toContain('filterCompletedPurchaseItems');
    expect(source).toContain('模糊搜索采购单号、物资、人员或供应商');
    expect(source).toContain('筛选楼栋');
    expect(source).toContain('筛选供应商');
    expect(source).toContain('筛选分类');
    expect(source).toContain('筛选完成日期');
    expect(source).not.toContain('analysis.completedItems.slice(0, 10)');
    expect(source).toContain('align-middle px-4 py-3.5 text-center');

    const overviewSource = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );
    expect(overviewSource).toContain(
      'align-middle px-5 py-2.5 text-center',
    );
  });
});
