import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  expect(fs.existsSync(absolutePath)).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

describe('purchase and inventory page split', () => {
  it('registers the dedicated inventory route as an immersive page', () => {
    const appSource = read('client/src/app.tsx');
    const layoutSource = read('client/src/components/Layout.tsx');

    expect(appSource).toContain('path="/inventory-management"');
    expect(appSource).toContain('<InventoryManagementPage />');
    expect(layoutSource).toContain("pathname === '/inventory-management'");
  });

  it('uses a construction-scale shared command header', () => {
    const headerSource = read(
      'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
    );
    const navigationSource = read(
      'client/src/components/GlobalNavigation.tsx',
    );
    const registrySource = read('client/src/navigation/page-switcher.ts');

    expect(headerSource).not.toContain('<nav');
    expect(headerSource).not.toContain('managementTabs');
    expect(headerSource).toContain('activePage: ManagementPageKey;');
    expect(headerSource).toContain('actions?: ReactNode;');
    expect(headerSource).toContain('updatedAt: string;');
    expect(headerSource).toContain('onFilter?: () => void;');
    expect(headerSource).toContain('role="toolbar"');
    expect(headerSource).toContain('aria-label="供应链页面工具栏"');
    expect(headerSource).toContain('h-14 w-36');
    expect(headerSource).toContain('md:h-16 md:w-40');
    expect(headerSource).toContain(
      'text-2xl font-semibold tracking-tight md:text-3xl',
    );
    expect(headerSource).toContain('南通全景运维平台 · 采‑供‑存');
    expect(headerSource).not.toContain('PageSwitcher');
    expect(headerSource).not.toContain('UnifiedAccessControl');

    expect(headerSource.indexOf('<Search')).toBeLessThan(
      headerSource.indexOf('onClick={onFilter}'),
    );
    expect(headerSource.indexOf('onClick={onFilter}')).toBeLessThan(
      headerSource.indexOf('{actions}'),
    );
    expect(headerSource.indexOf('{actions}')).toBeLessThan(
      headerSource.indexOf('onClick={onRefresh}'),
    );
    expect(navigationSource).toContain('useAccess');
    expect(navigationSource).toContain('getAccessibleNavigationDomains(role)');
    expect(navigationSource).toContain(
      "aria-current={active ? 'page' : undefined}",
    );
    expect(registrySource).toContain("label: '采‑供‑存'");
  });

  it('keeps the purchase overview focused on four active stages', () => {
    const purchaseSource = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    const headerUsage = purchaseSource.slice(
      purchaseSource.indexOf('<ManagementHeader'),
      purchaseSource.indexOf('<main'),
    );

    expect(headerUsage).toContain('activePage="purchase"');
    expect(headerUsage).toContain('updatedAt=');
    expect(headerUsage).toContain('onFilter=');
    expect(headerUsage).toContain('actions=');
    expect(headerUsage).toContain('新建采购申请');
    expect(purchaseSource).not.toContain('<ManagementPageSwitcher');
    expect(purchaseSource).not.toContain('aria-label="采购总览页面操作"');
    expect(purchaseSource).toContain('采购申请阶段清单');
    expect(purchaseSource).toContain('采购执行动态明细');
    expect(purchaseSource).toContain("key: 'approval'");
    expect(purchaseSource).not.toContain("key: 'stocked', label: '已闭环'");
    expect(purchaseSource).not.toContain('<InventoryOverviewPanel');
    expect(purchaseSource).not.toContain('<InventoryAlertPanel');
    expect(purchaseSource).not.toContain('<InventoryMovementPanel');
  });

  it('uses the approved summary and detail-list layout', () => {
    const purchaseSource = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(purchaseSource).toContain('aria-label="采购经营概览"');
    expect(purchaseSource).toContain('xl:grid-cols-2');
    expect(purchaseSource).toContain('sm:grid-cols-2');
    expect(purchaseSource).toContain('title="采购申请阶段清单"');
    expect(purchaseSource).toContain('title="采购执行动态明细"');
    expect(purchaseSource).toContain('title="签收待入库明细"');
    expect(purchaseSource).toContain('mode="application"');
    expect(purchaseSource).toContain('mode="execution"');
    expect(purchaseSource).toContain('mode="inbound"');
    expect(purchaseSource).toContain('items={inboundItems}');
    expect(purchaseSource.indexOf('<SourceStatus')).toBeLessThan(
      purchaseSource.indexOf('title="签收待入库明细"'),
    );
    expect(purchaseSource.indexOf('<StageDistributionChart')).toBeLessThan(
      purchaseSource.indexOf('title="采购申请阶段清单"'),
    );
    expect(purchaseSource).toContain("label: '采购申请'");
    expect(purchaseSource).toContain("label: '待收货签收'");
    expect(purchaseSource).toContain('setApplicationDialogOpen(true)');
  });

  it('provides a live-data inventory workspace', () => {
    const inventorySource = read(
      'client/src/pages/InventoryManagement/index.tsx',
    );
    const inventoryNavigation = read(
      'client/src/pages/InventoryManagement/InventorySectionNav.tsx',
    );

    const headerUsage = inventorySource.slice(
      inventorySource.indexOf('<ManagementHeader'),
      inventorySource.indexOf('<main'),
    );

    expect(headerUsage).toContain('activePage="inventory"');
    expect(headerUsage).toContain('updatedAt=');
    expect(headerUsage).toContain('showSearch={false}');
    expect(headerUsage).not.toContain('onFilter=');
    expect(headerUsage).toContain('actions=');
    expect(headerUsage).toContain('新增入库');
    expect(inventorySource).not.toContain('<ManagementPageSwitcher');
    expect(inventorySource).toContain('setSearchParams');
    expect(inventorySource).toContain(
      "nextSearchParams.set('view', 'inbound')",
    );
    expect(inventorySource).toContain(
      "nextSearchParams.set('action', 'create')",
    );
    expect(inventorySource).toContain('createRequested=');
    expect(inventorySource).toContain('onCreateRequestHandled=');
    expect(inventorySource).toContain('getInventoryManagementDashboard');
    expect(inventorySource).toContain('getInventoryManagementItems');
    expect(inventorySource).not.toContain('getPurchaseInventoryDashboard');
    expect(inventorySource).toContain('库存品类');
    expect(inventorySource).toContain('库存总量');
    expect(inventorySource).toContain('库存价值');
    expect(inventorySource).toContain('风险库存');
    expect(inventorySource).toContain('七楼栋库存态势');
    expect(inventorySource).toContain('库存台账');
    expect(inventorySource).toContain('库存预警与盘点');
    expect(inventorySource).toContain('<InventoryMovementPage');
    expect(inventoryNavigation).toContain('入库管理');
    expect(inventoryNavigation).toContain('出库管理');
    expect(inventoryNavigation).toContain('借调管理');
    expect(inventorySource).toContain("'borrow'");
    expect(inventorySource).toContain('items.totalPages');
  });
});
