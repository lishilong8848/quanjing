import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('inventory secondary pages UI', () => {
  const root = process.cwd();

  it('provides URL-addressable inventory sections with complete movement pages', () => {
    const page = readFileSync(
      join(root, 'client/src/pages/InventoryManagement/index.tsx'),
      'utf8',
    );
    const navigation = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventorySectionNav.tsx',
      ),
      'utf8',
    );
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(page).toContain('useSearchParams');
    expect(page).toContain('<InventorySectionNav');
    expect(page).toContain('<InventoryMovementPage');
    expect(page).toContain("activeSection === 'overview'");
    expect(page).toContain("activeSection === 'ledger'");
    expect(page).toContain("activeSection === 'stocktake'");

    for (const label of [
      '总览',
      '库存台账',
      '入库管理',
      '出库管理',
      '借调管理',
      '盘点与预警',
    ]) {
      expect(navigation).toContain(label);
    }
    expect(navigation).toContain("searchParams.set('view'");

    expect(movementPage).toContain('getInventoryManagementMovements');
    expect(movementPage).toContain('全部楼栋');
    expect(movementPage).toContain('全部状态');
    expect(movementPage).toContain('预计归还');
    expect(movementPage).toContain('重新加载');
    expect(movementPage).toContain('md:hidden');
    expect(movementPage).toContain('hidden overflow-x-auto md:block');
    expect(movementPage).toContain("type === 'inbound'");
    expect(movementPage).toContain("type === 'outbound'");
    expect(movementPage).toContain("type === 'borrow'");
  });

  it('keeps an invalid ledger API response inside the existing error state', () => {
    const page = readFileSync(
      join(root, 'client/src/pages/InventoryManagement/index.tsx'),
      'utf8',
    );

    expect(page).toMatch(
      /if \(\s*!response\s*\|\|\s*!Array\.isArray\(response\.items\)\s*\|\|\s*!Array\.isArray\(response\.categories\)\s*\|\|\s*!Number\.isFinite\(response\.total\)\s*\|\|\s*!Number\.isFinite\(response\.page\)\s*\|\|\s*!Number\.isFinite\(response\.totalPages\)\s*\)/,
    );
    expect(
      page.indexOf("throw new Error('Invalid inventory items response')"),
    ).toBeLessThan(page.indexOf('setItems(response)'));
  });

  it('force-refreshes both the dashboard and ledger from the manual refresh action', () => {
    const page = readFileSync(
      join(root, 'client/src/pages/InventoryManagement/index.tsx'),
      'utf8',
    );
    const refreshSource = page.slice(
      page.indexOf('const refreshAll = useCallback'),
      page.indexOf('const resetFilters'),
    );

    expect(refreshSource).toContain('await loadDashboard(true)');
    expect(refreshSource).toContain('await loadItems(true)');
    expect(refreshSource).not.toContain('await loadItems(false)');
  });
});
