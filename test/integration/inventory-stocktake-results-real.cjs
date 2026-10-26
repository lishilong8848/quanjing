// Explicitly invoked, identifiable test records only; never loads the inventory source.
require('reflect-metadata');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'CommonJS',
    moduleResolution: 'node',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  },
});
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, '../..'),
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { HttpService } = require('@nestjs/axios');
const {
  getEffectiveFeishuAppCredentials,
} = require('../../server/common/config/external-services.config.ts');
const {
  InventoryWorkflowGateway,
} = require('../../server/modules/inventory-management/inventory-workflow.gateway.ts');
const {
  InventoryStocktakeResultsGateway,
} = require('../../server/modules/inventory-management/inventory-stocktake-results.gateway.ts');
const {
  InventoryStocktakeResultsSync,
} = require('../../server/modules/inventory-management/inventory-stocktake-results.sync.ts');
const {
  InventoryStocktakeStore,
} = require('../../server/modules/inventory-management/inventory-stocktake.store.ts');
const {
  InventoryStocktakeService,
} = require('../../server/modules/inventory-management/inventory-stocktake.service.ts');
const output = path.resolve('output/inventory-stocktake-results-check');
fs.mkdirSync(output, { recursive: true });
const ledgerPath = path.join(output, 'real-test-ledger.json');
const manifestPath = path.join(output, 'real-test-records.json');
const started = Date.now();
const inputs =
  require('../fixtures/inventory-stocktake-evidence.cjs').fingerprintSources([
    'test/integration/inventory-stocktake-results-real.cjs',
  ]);
(async () => {
  if (getEffectiveFeishuAppCredentials().appId !== 'cli_0831564613853b26')
    throw new Error('当前运行应用与已确认人员 Open ID 所属应用不同，未写入');
  const http = new HttpService();
  const inventory = new InventoryWorkflowGateway(http);
  const gateway = new InventoryStocktakeResultsGateway(http, inventory);
  const store = new InventoryStocktakeStore(ledgerPath);
  const sync = new InventoryStocktakeResultsSync(store, gateway);
  const existing = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;
  const runId = existing?.runId || crypto.randomUUID();
  const month = '2026-10';
  const items = Array.from({ length: 3 }, (_, i) => ({
    recordId: `NT-STOCKTAKE-TEST-${runId}-${i}`,
    sku: `TEST-${i}`,
    name: `【盘点同步测试】${runId.slice(0, 8)}-${i}`,
    quantity: 2,
    building: 'A楼',
    location: '测试库房 · 货架1',
    specification: 'TEST-ONLY',
    brand: '',
    primaryCategory: '测试',
    secondaryCategory: '测试',
    unit: '个',
    owners: [],
  }));
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        runId,
        inventoryIds: items.map((i) => i.recordId),
        recordIds: existing?.recordIds || [],
        testOnly: true,
      },
      null,
      2,
    ),
  );
  const person = {
    recordId: 'verified-test-person',
    name: '示例人员020',
    openId: 'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID',
    employeeNo: 'TEST-ONLY',
    building: 'A楼',
    position: '',
    specialty: '',
  };
  const principal = { role: 'admin', purchaseBuilding: null };
  const service = new InventoryStocktakeService(
    store,
    {
      snapshot: async () => ({ items, movements: [] }),
      currentMany: async () => items,
      current: async (i) => i,
    },
    { resolveApplicantForBuilding: async () => person },
  );
  service.generateMissing(month, 'A楼', { items, movements: [] });
  await sync.drain();
  assert.equal(sync.summary(month, 'A楼', 'sample').success, 1);
  assert.equal(sync.summary(month, 'A楼', 'review').success, 2);
  let sheet = service.get(month, 'A楼', principal, 'review');
  const body = {
    month,
    building: 'A楼',
    scope: 'review',
    clientMutationId: `real-bulk-${runId}`,
    expectedVersion: sheet.version,
    confirmer: person,
    lines: sheet.lines.map((l, i) => ({
      recordId: l.inventory.recordId,
      expectedVersion: l.version,
      actualQuantity: i === 0 ? 0 : null,
      confirmer: null,
      note: i === 0 ? '可识别测试记录，验证盘亏及撤销' : '',
    })),
  };
  sheet = await service.confirmReview(body, principal, 'real-test-session');
  assert(
    sheet.lines.every((l) => l.sync.clientMutationId === body.clientMutationId),
  );
  await sync.drain();
  assert.equal(sync.summary(month, 'A楼', 'review').success, 2);
  const confirmed = sheet.lines.map((l) => ({
    recordId: l.inventory.recordId,
    confirmer: l.confirmer.openId,
    actualQuantity: l.actualQuantity,
  }));
  sheet = service.undoReview(
    {
      month,
      building: 'A楼',
      scope: 'review',
      expectedVersion: sheet.version,
      batchId: sheet.latestBulk.id,
      clientMutationId: `real-undo-${runId}`,
    },
    principal,
    'real-test-session',
  );
  await sync.drain();
  assert.equal(sync.summary(month, 'A楼', 'review').success, 2);
  const index = await gateway.index();
  const recordIds = items.map((i) => index.get(i.recordId));
  assert(recordIds.every(Boolean));
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        runId,
        inventoryIds: items.map((i) => i.recordId),
        recordIds,
        testOnly: true,
      },
      null,
      2,
    ),
  );
  const target = gateway.target;
  for (const recordId of recordIds)
    await inventory.deleteRecord(
      target.base,
      target.table,
      recordId,
      '盘点同步测试记录',
    );
  const after = await gateway.index();
  assert(items.every((i) => !after.has(i.recordId)));
  const evidence = {
    inputs,
    schemaMappingSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(output, 'feishu-field-mapping.json')))
      .digest('hex'),
    passed: true,
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    runId,
    created: recordIds.length,
    confirmed,
    undo: sheet.latestBulk.status,
    cleaned: recordIds.length,
    remainingTestRecords: 0,
  };
  fs.writeFileSync(
    path.join(output, 'real-test-result.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      created: recordIds.length,
      cleaned: recordIds.length,
      elapsedMs: evidence.elapsedMs,
    }),
  );
})().catch((error) => {
  console.error(`REAL_TEST_FAILED: ${error.message}`);
  process.exitCode = 1;
});
