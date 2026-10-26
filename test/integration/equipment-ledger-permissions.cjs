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
const path = require('node:path');
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, '../..'),
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { APP_GUARD } = require('@nestjs/core');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const helpers = require('../../server/common/feishu/bitable-direct-read');
let reads = 0;
let failRead = false;
const buildings = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];
helpers.createBitableBackgroundRefresh = () => ({ start() {}, stop() {} });
helpers.readLatestPersistedBitableRecordSnapshot = async () => null;
helpers.resolveBitableAppToken = async () => 'fixture';
helpers.fetchBitableRecords = async () => {
  ++reads;
  if (failRead) throw new Error('fixture offline');
  return buildings.flatMap((building, i) => [
    {
      record_id: `asset-${i}`,
      fields: {
        机楼: building,
        设备名称: `UPS-${building}`,
        大设备类型: 'UPS',
        品牌: `品牌-${building}`,
        型号: `型号-${building}`,
        设备编号: `${i}-001`,
        维保截止日期: '2099-01-01',
      },
    },
    {
      record_id: `collection-${i}`,
      fields: {
        机楼: building,
        设备名称: `汇总-${building}`,
        条目性质: '集合条目',
      },
    },
  ]);
};
const {
  EquipmentLifecycleModule,
} = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.module');
const {
  EquipmentLifecycleService,
} = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.service');
const {
  EquipmentLedgerController,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.controller');
const {
  UnifiedAccessGuard,
} = require('../../server/common/access/unified-access.guard');
const {
  UnifiedAccessService,
} = require('../../server/common/access/unified-access.service');
const { canAccessPage } = require('../../client/src/access/access-policy');
const principals = Object.fromEntries(
  buildings.map((purchaseBuilding, i) => [
    `supervisor-${i}`,
    { role: 'building_admin', purchaseBuilding },
  ]),
);
for (const role of [
  'admin',
  'editor',
  'guest',
  'inventory_admin',
  'purchase_admin',
  'purchase_applicant',
  'duty_editor',
  'construction_admin',
  'supply_chain_admin',
])
  principals[role] = { role, purchaseBuilding: null };
principals.station = { role: 'building_admin', purchaseBuilding: '110站' };
let checks = 0;
const check = (actual, expected) => {
  assert.deepEqual(actual, expected);
  ++checks;
};
(async () => {
  const started = Date.now();
  const related = buildings.map((building, i) => ({
    id: `r-${i}`,
    building,
    name: `关联-${building}`,
    status: '在保',
    dueDate: '2099-01-01',
  }));
  const runtime = await Test.createTestingModule({
    imports: [EquipmentLifecycleModule],
    providers: [
      UnifiedAccessGuard,
      { provide: APP_GUARD, useExisting: UnifiedAccessGuard },
      {
        provide: UnifiedAccessService,
        useValue: {
          cookieName: 'fixture_session',
          isAccessControlEnabled: () => true,
          renew: (token) =>
            principals[token]
              ? { principal: principals[token], principalFingerprint: token }
              : null,
        },
      },
    ],
  })
    .overrideProvider(EquipmentLifecycleService)
    .useValue({
      getDashboard: async () => ({
        sourceStatus: 'fresh',
        assets: related.map((r) => ({
          ...r,
          deviceName: r.name,
          currentExpiryDate: r.dueDate,
        })),
        relatedRecords: {
          longTermMaintenance: related,
          keyParts: related,
          maintenanceContracts: related,
        },
      }),
    })
    .compile();
  const app = runtime.createNestApplication();
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const get = async (token, endpoint, query = {}) => {
      const response = await fetch(
        `${base}/api/equipment-ledger/${endpoint}?${new URLSearchParams(query)}`,
        { headers: token ? { cookie: `fixture_session=${token}` } : {} },
      );
      return { status: response.status, body: await response.json() };
    };
    for (const token of ['admin', 'editor']) {
      check(canAccessPage(token, '/equipment-ledger-management'), true);
      check((await get(token, 'dashboard')).body.overview.metrics.total, 5);
      check((await get(token, 'items')).body.items.length, 5);
      check(
        (await get(token, 'lifecycle')).body.maintenanceContracts.length,
        5,
      );
    }
    for (const [i, building] of buildings.entries()) {
      const token = `supervisor-${i}`;
      check(
        canAccessPage('building_admin', '/equipment-ledger-management'),
        true,
      );
      const dashboard = (await get(token, 'dashboard')).body;
      check(dashboard.overview.metrics.total, 1);
      check(dashboard.overview.metrics.collections, 1);
      check(dashboard.overview.models, [
        { name: `型号-${building}`, count: 1 },
      ]);
      check(
        dashboard.buildings.map((b) => b.building),
        [building],
      );
      const state = (await get(token, 'dashboard', { async: '1' })).body;
      check(state.dashboard, dashboard);
      const page = (
        await get(token, 'items', { search: 'UPS', pageSize: '100' })
      ).body;
      check(
        page.items.map((a) => a.building),
        [building],
      );
      check(page.snapshotId, dashboard.snapshotId);
      check(
        (await get(token, 'items', { kind: 'collection' })).body.items.map(
          (a) => a.building,
        ),
        [building],
      );
      check(
        (await get(token, 'items', { id: `asset-${(i + 1) % 5}` })).body.total,
        0,
      );
      for (const foreign of buildings.filter((b) => b !== building))
        check(
          (
            await get(token, 'items', {
              building: foreign,
              id: `asset-${i}`,
              role: 'admin',
              purchaseBuilding: foreign,
            })
          ).status,
          403,
        );
      check(
        (
          await get(token, 'items', {
            building: [building, buildings[(i + 1) % 5]],
          })
        ).status,
        403,
      );
      const lifecycle = (await get(token, 'lifecycle')).body;
      for (const key of [
        'assets',
        'longTermMaintenance',
        'keyParts',
        'maintenanceContracts',
      ])
        check(
          lifecycle[key].map((r) => r.building),
          [building],
        );
    }
    for (const token of [
      '',
      'guest',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
      'duty_editor',
      'construction_admin',
      'supply_chain_admin',
      'station',
    ])
      for (const endpoint of ['dashboard', 'items', 'lifecycle'])
        check(
          (await get(token, endpoint, { role: 'admin', building: 'A楼' }))
            .status,
          403,
        );
    check(reads, 1);
    failRead = true;
    await get('supervisor-0', 'dashboard', { refresh: '1' });
    const stale = (await get('supervisor-0', 'dashboard', { async: '1' })).body;
    check(stale.dashboard.stale, true);
    check(stale.dashboard.overview.metrics.total, 1);
    check(
      stale.dashboard.buildings.map((b) => b.building),
      ['A楼'],
    );
    check((await get('admin', 'dashboard')).body.overview.metrics.total, 5);
    await assert.rejects(
      () => runtime.get(EquipmentLedgerController).getDashboard({}),
      /无设备台账访问权限/,
    );
    ++checks;
    console.log(
      JSON.stringify({
        status: 'passed',
        checks,
        guard: 'UnifiedAccessGuard',
        nestDI: true,
        sourceReads: reads,
        externalRequests: 0,
        elapsedMs: Date.now() - started,
      }),
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
