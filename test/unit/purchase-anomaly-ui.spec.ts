import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('purchase anomaly UI', () => {
  const source = readFileSync(
    resolve(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    ),
    'utf8',
  );

  it('renders a source-backed anomaly card with issue labels and record location', () => {
    expect(source).toContain('buildPurchaseAnomalies');
    expect(source).toContain('采购异常项目');
    expect(source).toContain('<PurchaseAnomalyPanel');
    expect(source).toContain('anomaly.issues.map');
    expect(source).toContain('onEdit');
    expect(source).toContain('onDeleteAnomaly');
  });

  it('uses 暂无 instead of 待确定 for empty suppliers', () => {
    expect(source).not.toContain("item.supplier || '待确定'");
    expect(source).not.toContain("item.supplier || '供应商待确定'");
    expect(source).toContain("item.supplier || '暂无'");
  });
});
