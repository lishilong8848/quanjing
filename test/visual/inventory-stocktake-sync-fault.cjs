const path = require('node:path');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'CommonJS',
    moduleResolution: 'node',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  },
});
const {
  InventoryStocktakeStore,
} = require('../../server/modules/inventory-management/inventory-stocktake.store.ts');
const ledgerPath = path.resolve(
  'output/inventory-stocktake-results-check/browser-fixture/fixture-ledger.json',
);
const store = new InventoryStocktakeStore(ledgerPath);
store.update((state) => {
  const line = state.sheets
    .find((s) => s.month === '2026-10' && s.building === 'A楼')
    ?.review?.lines.find((l) => l.status === 'confirmed');
  if (
    !line ||
    !line.inventory.recordId.startsWith('test-') ||
    !line.sync ||
    line.sync.status !== 'success'
  )
    throw new Error('模拟同步失败只允许注入已核验的测试夹具');
  line.sync.status = 'error';
  line.sync.attempts = 3;
  line.sync.error = '测试飞书同步失败，请重试';
  line.sync.retryAt = null;
  line.sync.syncedAt = null;
  return true;
});
console.log('FIXTURE_SYNC_ERROR_INJECTED');
