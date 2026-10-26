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
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const {
  EquipmentLifecycleModule,
} = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.module');
const {
  EquipmentLedgerService,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
const {
  EquipmentLedgerController,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.controller');
const { canAccessPage } = require('../../client/src/access/access-policy');
(async () => {
  const started = Date.now();
  const module = await Test.createTestingModule({
    imports: [EquipmentLifecycleModule],
  }).compile();
  assert(module.get(EquipmentLedgerService) instanceof EquipmentLedgerService);
  assert(
    module.get(EquipmentLedgerController) instanceof EquipmentLedgerController,
  );
  await module.close();
  const queries = [];
  const service = {
    getItems: (query) => {
      queries.push(query);
      return { query };
    },
    getDashboard: () => ({ overview: {} }),
    getDashboardState: () => ({
      status: 'loading',
      dashboard: null,
      refreshing: true,
      error: '',
    }),
    getLifecycle: () => ({ status: 'fresh' }),
  };
  const runtime = await Test.createTestingModule({
    imports: [EquipmentLifecycleModule],
  })
    .overrideProvider(EquipmentLedgerService)
    .useValue(service)
    .compile();
  const app = runtime.createNestApplication();
  app.use((req, _res, next) => {
    req.accessPrincipal = { role: 'admin', purchaseBuilding: null };
    next();
  });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const loading = await fetch(
      `${base}/api/equipment-ledger/dashboard?async=1`,
    );
    assert.equal(loading.status, 200);
    assert.equal((await loading.json()).status, 'loading');
    for (const query of [
      { kind: 'all' },
      { warranty: '未到期' },
      { system: '不存在' },
      { management: '不存在' },
      { page: '-1' },
      { page: 'Infinity' },
      { search: 'a'.repeat(201) },
    ])
      assert.equal(
        (
          await fetch(
            `${base}/api/equipment-ledger/items?${new URLSearchParams(query)}`,
          )
        ).status,
        400,
      );
    assert.equal(queries.length, 0);
    const response = await fetch(
      `${base}/api/equipment-ledger/items?building=C%E6%A5%BC&warranty=%E5%BE%85%E7%A1%AE%E8%AE%A4&page=2&pageSize=20&arbitrary=ignored`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).query, {
      kind: 'detail',
      building: 'C楼',
      warranty: '待确认',
      page: 2,
      pageSize: 20,
    });
    const grouped = await fetch(
      `${base}/api/equipment-ledger/items?${new URLSearchParams({ family: 'HVDC', system: '供配电', management: '代维楼' })}`,
    );
    assert.equal(grouped.status, 200);
    assert.deepEqual((await grouped.json()).query, {
      kind: 'detail',
      family: 'HVDC',
      system: '供配电',
      management: '代维楼',
    });
    for (const role of [
      'admin',
      'editor',
      'guest',
      'building_admin',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
      'duty_editor',
      'construction_admin',
      'supply_chain_admin',
    ])
      assert.equal(
        canAccessPage(role, '/equipment-ledger-management'),
        role === 'admin' || role === 'editor' || role === 'building_admin',
      );
    console.log(
      JSON.stringify({
        status: 'passed',
        nestDI: true,
        invalidQueries: 7,
        roleComparisons: 10,
        elapsedMs: Date.now() - started,
      }),
    );
  } finally {
    await app.close();
  }
})().catch(() => {
  console.error('LEDGER_MODULE_ACCEPTANCE_FAILED');
  process.exitCode = 1;
});
