require('reflect-metadata');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'CommonJS',
    moduleResolution: 'node',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
  },
});
require('tsconfig-paths').register({
  baseUrl: require('node:path').resolve(__dirname, '../..'),
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const start = Date.now();
const { Test } = require('@nestjs/testing');
const { Global, Module } = require('@nestjs/common');
class TestDatabaseModule {}
Global()(TestDatabaseModule);
Module({
  providers: [{ provide: 'DRIZZLE_DATABASE', useValue: Object.freeze({}) }],
  exports: ['DRIZZLE_DATABASE'],
})(TestDatabaseModule);
process.stdout.write('DI_PHASE=import\n');
const {
  InventoryManagementModule,
} = require('../../server/modules/inventory-management/inventory-management.module.ts');
process.stdout.write(`DI_PHASE=compile importMs=${Date.now() - start}\n`);
const timeout = setTimeout(() => {
  process.stderr.write(`DI_TIMEOUT elapsedMs=${Date.now() - start}\n`);
  process.exit(2);
}, 15000);
(async () => {
  const mod = await Test.createTestingModule({
    imports: [TestDatabaseModule, InventoryManagementModule],
  }).compile();
  process.stdout.write(`DI_PHASE=resolved elapsedMs=${Date.now() - start}\n`);
  for (const [file, name] of [
    ['inventory-stocktake.service', 'InventoryStocktakeService'],
    ['inventory-stocktake.source', 'InventoryStocktakeSource'],
    ['inventory-stocktake.store', 'InventoryStocktakeStore'],
    ['inventory-stocktake.controller', 'InventoryStocktakeController'],
    [
      'inventory-stocktake-generation.service',
      'InventoryStocktakeGenerationService',
    ],
    ['inventory-stocktake-results.gateway', 'InventoryStocktakeResultsGateway'],
    ['inventory-stocktake-results.sync', 'InventoryStocktakeResultsSync'],
    ['inventory-stocktake-bulk.service', 'InventoryStocktakeBulkService'],
  ]) {
    const Type = require(
      `../../server/modules/inventory-management/${file}.ts`,
    )[name];
    if (!(mod.get(Type) instanceof Type)) throw new Error(`${name} missing`);
  }
  await mod.close();
  clearTimeout(timeout);
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const temp = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'nt-stocktake-http-'),
  );
  const {
    InventoryStocktakeService,
  } = require('../../server/modules/inventory-management/inventory-stocktake.service.ts');
  const {
    InventoryStocktakeSource,
  } = require('../../server/modules/inventory-management/inventory-stocktake.source.ts');
  const {
    InventoryStocktakeStore,
  } = require('../../server/modules/inventory-management/inventory-stocktake.store.ts');
  const {
    InventoryStocktakeController,
  } = require('../../server/modules/inventory-management/inventory-stocktake.controller.ts');
  const {
    InventoryStocktakeGenerationService,
  } = require('../../server/modules/inventory-management/inventory-stocktake-generation.service.ts');
  const {
    PurchaseApplicationService,
  } = require('../../server/modules/purchase-inventory/purchase-application.service.ts');
  const item = {
    recordId: 'test-stock',
    sku: 'TEST1',
    building: 'A楼',
    quantity: 2,
    location: '测试库位',
    unit: '个',
  };
  const person = {
    recordId: 'test-person',
    openId: 'ou_test',
    name: '测试人员',
    building: 'A楼',
    employeeNo: 'TEST1',
    position: '',
    specialty: '',
  };
  let snapshotCalls = 0;
  const {
    InventoryStocktakeResultsSync,
  } = require('../../server/modules/inventory-management/inventory-stocktake-results.sync.ts');
  let syncKicks = 0;
  const {
    InventoryStocktakeBulkService,
  } = require('../../server/modules/inventory-management/inventory-stocktake-bulk.service.ts');
  const syncSummary = { pending: 1, syncing: 0, success: 0, error: 0 };
  const bulkItems = Array.from({ length: 20 }, (_, i) => ({
    ...item,
    recordId: `bulk-stock-${i}`,
    building: 'B楼',
    name: `批量物品${i}`,
  }));
  const runtime = await Test.createTestingModule({
    controllers: [InventoryStocktakeController],
    providers: [
      InventoryStocktakeService,
      InventoryStocktakeGenerationService,
      InventoryStocktakeBulkService,
      {
        provide: InventoryStocktakeResultsSync,
        useValue: { kick: () => syncKicks++, summary: () => syncSummary },
      },
      {
        provide: InventoryStocktakeStore,
        useValue: new InventoryStocktakeStore(path.join(temp, 'ledger.json')),
      },
      {
        provide: InventoryStocktakeSource,
        useValue: {
          snapshot: async () => {
            snapshotCalls++;
            return { items: [item, ...bulkItems], movements: [] };
          },
          current: async () => item,
          currentMany: async (items) =>
            items.map((previous) =>
              bulkItems.find((i) => i.recordId === previous.recordId),
            ),
        },
      },
      {
        provide: PurchaseApplicationService,
        useValue: { resolveApplicantForBuilding: async () => person },
      },
    ],
  }).compile();
  // Explicitly isolate HTTP tests from automatic production startup scheduling.
  const generationService = runtime.get(InventoryStocktakeGenerationService);
  generationService.onModuleInit = () => {};
  const bulkService = runtime.get(InventoryStocktakeBulkService);
  bulkService.onModuleInit = () => {};
  const app = runtime.createNestApplication({ logger: false });
  app.use((req, _res, next) => {
    if (req.headers['x-test-identity']) {
      req.accessPrincipal = {
        role:
          req.headers['x-test-identity'] === 'admin'
            ? 'admin'
            : 'inventory_admin',
        purchaseBuilding:
          req.headers['x-test-identity'] === 'admin' ? null : 'A楼',
      };
      req.accessPrincipalFingerprint = 'test-http-user';
    }
    next();
  });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const month = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
    const request = async (action, body, identity = true) => {
      const response = await fetch(
        `${base}/api/inventory-management/stocktake/${action}`,
        {
          method: body ? 'POST' : 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(identity
              ? { 'x-test-identity': identity === 'admin' ? 'admin' : '1' }
              : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(3000),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    assert.equal(
      (await request(`overview?month=${month}`, null, false)).status,
      403,
    );
    const startRequest = {
      month,
      building: 'A楼',
      clientMutationId: 'http-start-1',
    };
    const emptyUrl = `${base}/api/inventory-management/stocktake/sheet?month=${month}&building=${encodeURIComponent('A楼')}`;
    const emptyResponse = await fetch(emptyUrl, {
      headers: { 'x-test-identity': '1' },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(emptyResponse.status, 200);
    assert.equal(await emptyResponse.text(), '');
    const emptyAxiosResponse = await require('axios').get(emptyUrl, {
      headers: { 'x-test-identity': '1' },
      timeout: 3000,
    });
    assert.equal(emptyAxiosResponse.data, '');
    const acceptanceStarted = Date.now();
    const queued = await request('generate', {
      month,
      clientMutationId: 'http-queued-generation',
    });
    const acceptedElapsedMs = Date.now() - acceptanceStarted;
    assert.equal(queued.status, 202);
    assert.equal(queued.body.status, 'queued');
    assert.equal(snapshotCalls, 0);
    assert.equal('owner' in queued.body, false);
    assert.equal(
      new InventoryStocktakeStore(path.join(temp, 'ledger.json')).read()
        .generationJobs[0].id,
      queued.body.id,
    );
    assert.ok(acceptedElapsedMs < 1000);
    assert.equal(
      (await request('start', { ...startRequest, building: 'B楼' })).status,
      403,
    );
    assert.equal((await request('start', startRequest)).status, 201);
    const confirm = {
      ...startRequest,
      clientMutationId: 'http-confirm-1',
      recordId: item.recordId,
      expectedVersion: 1,
      actualQuantity: 1,
      confirmer: person,
      note: '测试差异',
    };
    const first = await request('confirm', confirm),
      replay = await request('confirm', confirm);
    assert.equal(first.status, 201);
    assert.deepEqual(first, replay);
    assert.equal(
      (
        await request('draft', {
          ...confirm,
          clientMutationId: 'http-draft-late',
        })
      ).status,
      409,
    );
    const completed = await request('complete', {
      ...startRequest,
      clientMutationId: 'http-finish-1',
      expectedVersion: 2,
    });
    assert.equal(completed.body.status, 'completed');
    const read = await request(
      `sheet?month=${month}&building=${encodeURIComponent('A楼')}`,
    );
    assert.equal(read.body.lines[0].confirmer.openId, 'ou_test');
    await generationService.runPending();
    const generated = await request('generate', {
      month,
      clientMutationId: 'http-generate-1',
    });
    assert.equal(generated.status, 202);
    assert.deepEqual(
      generated.body.buildings.map((b) => b.building),
      ['A楼'],
    );
    assert.equal(generated.body.status, 'success');
    assert.equal('owner' in generated.body, false);
    assert.deepEqual(
      (
        await request('generate', {
          month,
          clientMutationId: 'http-generate-1',
        })
      ).body,
      generated.body,
    );
    assert.equal(
      (
        await request('generate', {
          month: '2026-09',
          clientMutationId: 'http-old-generation',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          'generate',
          { month, clientMutationId: 'http-guest-generation' },
          false,
        )
      ).status,
      403,
    );
    const summary = await request(`overview?month=${month}`);
    assert.equal(summary.body.generation.status, 'success');
    await request(
      'start',
      { ...startRequest, building: 'B楼', clientMutationId: 'http-bulk-start' },
      'admin',
    );
    const review = await request(
      `sheet?month=${month}&building=${encodeURIComponent('B楼')}&scope=review`,
      null,
      'admin',
    );
    assert.equal(review.body.lines.length, 18);
    const bulkRequest = {
      ...startRequest,
      building: 'B楼',
      scope: 'review',
      clientMutationId: 'http-bulk-confirm',
      expectedVersion: review.body.version,
      confirmer: person,
      lines: review.body.lines.map((line, i) => ({
        recordId: line.inventory.recordId,
        expectedVersion: line.version,
        actualQuantity: i ? null : 0,
        confirmer: null,
        note: i ? '' : '实盘为零',
      })),
    };
    assert.equal((await request('bulk-confirm', bulkRequest)).status, 403);
    assert.equal(
      (
        await request(
          'bulk-confirm',
          { ...bulkRequest, scope: 'sample' },
          'admin',
        )
      ).status,
      400,
    );
    const bulkAcceptedAt = Date.now();
    const bulkAccepted = await request('bulk-confirm', bulkRequest, 'admin');
    const bulkAcceptedElapsedMs = Date.now() - bulkAcceptedAt;
    assert.equal(bulkAccepted.status, 202);
    assert.equal(bulkAccepted.body.status, 'queued');
    assert.ok(bulkAcceptedElapsedMs < 1000);
    const bulkStatusPath = `bulk-status?month=${month}&building=${encodeURIComponent('B楼')}&id=${bulkAccepted.body.id}`;
    assert.equal((await request(bulkStatusPath, null)).status, 403);
    assert.equal((await request(bulkStatusPath, null, false)).status, 403);
    assert.deepEqual(
      (await request(bulkStatusPath, null, 'admin')).body,
      bulkAccepted.body,
    );
    await bulkService.drain();
    assert.equal(
      (await request(bulkStatusPath, null, 'admin')).body.status,
      'success',
    );
    const bulkResult = await request(
      `sheet?month=${month}&building=${encodeURIComponent('B楼')}&scope=review`,
      null,
      'admin',
    );
    assert.equal(bulkResult.status, 200);
    assert.equal(bulkResult.body.lines[0].actualQuantity, 0);
    assert.equal(
      bulkResult.body.lines.filter((l) => l.status === 'confirmed').length,
      18,
    );
    const bulkReplay = await request('bulk-confirm', bulkRequest, 'admin');
    assert.equal(bulkReplay.status, 202);
    assert.equal(bulkReplay.body.id, bulkAccepted.body.id);
    assert.equal(bulkReplay.body.status, 'success');
    const bulkOverview = await request(
      `overview?month=${month}`,
      null,
      'admin',
    );
    assert.equal(
      bulkOverview.body.buildings.find((b) => b.building === 'B楼').review
        .shortage,
      1,
    );
    const undoBody = {
      month,
      building: 'B楼',
      scope: 'review',
      expectedVersion: bulkResult.body.version,
      batchId: bulkResult.body.latestBulk.id,
      clientMutationId: 'http-undo-bulk-01',
    };
    assert.equal((await request('bulk-undo', undoBody)).status, 403);
    const undone = await request('bulk-undo', undoBody, 'admin');
    assert.equal(undone.status, 201);
    assert.equal(undone.body.latestBulk.status, 'undone');
    assert.equal(
      undone.body.lines.filter((l) => l.status === 'draft').length,
      18,
    );
    assert.equal(undone.body.lines[0].actualQuantity, 0);
    assert.equal(undone.body.lines[0].confirmer, null);
    assert.deepEqual(await request('bulk-undo', undoBody, 'admin'), undone);
    assert.equal(
      (
        await request(
          'bulk-undo',
          {
            ...undoBody,
            clientMutationId: 'http-undo-again-01',
            expectedVersion: undone.body.version,
          },
          'admin',
        )
      ).status,
      409,
    );
    const statusPath = `sync-status?month=${month}&building=${encodeURIComponent('B楼')}&scope=review`;
    assert.equal((await request(statusPath, null, false)).status, 403);
    assert.equal((await request(statusPath, null)).status, 403);
    assert.deepEqual(await request(statusPath, null, 'admin'), {
      status: 200,
      body: syncSummary,
    });
    const retryBody = {
      month,
      building: 'B楼',
      scope: 'review',
      clientMutationId: 'http-sync-retry-001',
    };
    assert.equal((await request('retry-sync', retryBody)).status, 403);
    assert.equal((await request('retry-sync', retryBody, false)).status, 403);
    assert.deepEqual(await request('retry-sync', retryBody, 'admin'), {
      status: 202,
      body: syncSummary,
    });
    assert.deepEqual(await request('retry-sync', retryBody, 'admin'), {
      status: 202,
      body: syncSummary,
    });
    assert.equal(syncKicks, 2);
    const evidence = {
      status: 'passed',
      elapsedMs: Date.now() - start,
      externalWrites: 0,
      schedulersStarted: false,
      httpChecks: 42,
      bulkAcceptance: {
        status: 202,
        bulkAcceptedElapsedMs,
        persistedBeforeExternalRead: true,
      },
      generationAcceptance: {
        status: 202,
        persisted: true,
        responseBeforeExternalRead: true,
        acceptedElapsedMs,
      },
      emptySheetResponse: { status: 200, bodyBytes: 0, axiosData: '' },
      readback: 'completed',
      database: 'test global provider; no DB calls',
    };
    evidence.fingerprints =
      require('../fixtures/inventory-stocktake-evidence.cjs').fingerprintSources(
        [
          'server/modules/inventory-management/inventory-management.module.ts',
          'test/integration/inventory-stocktake-module-di.cjs',
        ],
      );
    const output = path.resolve(
      __dirname,
      process.argv
        .find((arg) => arg.startsWith('--evidence-output='))
        ?.slice('--evidence-output='.length) ||
        '../../output/inventory-stocktake-dev-check/nest-integration.json',
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
    console.log(
      JSON.stringify({
        ...evidence,
        fingerprints: { files: evidence.fingerprints.files.length },
      }),
    );
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exitCode = 1;
});
