import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const FOUR_HOURS_EXPRESSION = '4 * 60 * 60 * 1000';

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('supply chain four-hour synchronization', () => {
  it.each([
    'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    'client/src/pages/ContractManagement/index.tsx',
    'client/src/pages/InventoryManagement/index.tsx',
  ])('polls %s every four hours', (relativePath) => {
    expect(read(relativePath)).toContain(
      `const AUTO_REFRESH_MS = ${FOUR_HOURS_EXPRESSION};`,
    );
  });

  it('uses four hours for supply-chain background refresh and local cache refresh', () => {
    const directRead = read('server/common/feishu/bitable-direct-read.ts');
    const bitableSync = read('server/modules/bitable-sync/bitable-sync.service.ts');
    const envExample = read('.env.example');
    const deploymentGuide = read('deploy/README_SUPPLY_CHAIN_CACHE.md');

    expect(directRead).toContain(
      `getPositiveIntegerEnv('FEISHU_SUPPLY_CHAIN_SYNC_INTERVAL_MS') ??\n    ${FOUR_HOURS_EXPRESSION}`,
    );
    expect(directRead).toContain(
      `getPositiveIntegerEnv('FEISHU_LOCAL_CACHE_TTL_MS') ?? ${FOUR_HOURS_EXPRESSION}`,
    );
    expect(bitableSync).toContain(
      `return Number.isFinite(parsed) && parsed > 0 ? parsed : ${FOUR_HOURS_EXPRESSION};`,
    );
    expect(envExample).toContain(
      'FEISHU_SUPPLY_CHAIN_SYNC_INTERVAL_MS=14400000',
    );
    expect(envExample).toContain('FEISHU_LOCAL_CACHE_TTL_MS=14400000');
    expect(envExample).toContain('FEISHU_LOCAL_CACHE_REFRESH_MS=14400000');
    expect(deploymentGuide).toContain(
      'FEISHU_SUPPLY_CHAIN_SYNC_INTERVAL_MS=14400000',
    );
    expect(deploymentGuide).toContain('默认每 4 小时在后台刷新一次');
  });

  it.each([
    'server/modules/purchase-inventory/purchase-inventory.service.ts',
    'server/modules/contract-management/contract-management.service.ts',
    'server/modules/inventory-management/inventory-management.service.ts',
  ])('keeps the %s dashboard snapshot for four hours', (relativePath) => {
    expect(read(relativePath)).toContain(
      `const CACHE_TTL_MS = ${FOUR_HOURS_EXPRESSION};`,
    );
  });

  it('keeps the purchase catalog snapshot for four hours', () => {
    expect(
      read('server/modules/purchase-inventory/purchase-application.service.ts'),
    ).toContain(`const CATALOG_CACHE_TTL_MS = ${FOUR_HOURS_EXPRESSION};`);
  });
});
