import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('purchase source status UI', () => {
  const source = readFileSync(
    resolve(
      __dirname,
      '../../client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    ),
    'utf8',
  );

  it('shows every unavailable or failed purchase data source instead of silent zeroes', () => {
    expect(source).toContain("label: '采购申请表'");
    expect(source).toContain("label: '采购执行表'");
    expect(source).toContain("label: '物品类别表'");
    expect(source).toContain("label: '库存台账表'");
    expect(source).toContain("label: '入库表'");
    expect(source).toContain("label: '出库表'");
    expect(source).toMatch(
      /sources\.filter\(\s*\(item\)\s*=>\s*!item\.status\.configured\s*\|\|\s*Boolean\(item\.status\.message\)/,
    );
    expect(source).toContain('数据源读取异常');
  });

  it('surfaces partial, stale, and failed background refreshes', () => {
    expect(source).toContain("response.refreshState === 'partial'");
    expect(source).toContain("response.refreshState === 'stale'");
    expect(source).toContain(
      "setLoadError('采购数据读取失败，请检查网络或飞书数据源后重试。')",
    );
  });

  it('labels an optimistic cold-start dashboard as base data still syncing', () => {
    expect(source).toContain(
      "setDashboardNotice('采购基础数据正在同步，本次申请已先显示。')",
    );
    expect(source).toContain("? '基础数据同步中'");
    expect(source).toContain('{renderedDashboardNotice && (');
  });
});
