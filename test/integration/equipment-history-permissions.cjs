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
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
require('tsconfig-paths').register({
  baseUrl: root,
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { APP_GUARD } = require('@nestjs/core');
const { Logger, Controller, Get, Post } = require('@nestjs/common');
Logger.overrideLogger(false);
const helpers = require('../../server/common/feishu/bitable-direct-read');
const floors = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];
let repairReads = 0;
let lifecycleReads = 0;
const ledger = floors.map((b, i) => ({
  record_id: `asset-${i}`,
  fields: {
    机楼: b,
    楼栋标识: b,
    设备名称: 'UPS',
    设备编号: `${b[0]}-311-UPS-01`,
    数量: 1,
  },
}));
const repairs = floors.map((b, i) => ({
  record_id: `repair-${i}`,
  fields: {
    维修单号: `单-${i}`,
    '所属数据中心/楼栋-使用': b,
    设备编号: `${b[0]}-311-UPS-01`,
    设备名称: 'UPS',
    台账关联状态: '已关联',
    关联台账记录ID: `asset-${i}`,
    流程: i ? '维修完成' : '未开始',
    '故障发生现象描述-L': `${b}故障`,
  },
}));
repairs.push({
  record_id: 'pending',
  fields: {
    ...repairs[0].fields,
    维修单号: '待确认单',
    台账关联状态: '待确认',
  },
});
repairs.push({
  record_id: 'stale-binding',
  fields: {
    ...repairs[0].fields,
    维修单号: '旧关联单',
    关联台账记录ID: 'removed-device',
  },
});
helpers.createBitableBackgroundRefresh = () => ({ start() {}, stop() {} });
helpers.readLatestPersistedBitableRecordSnapshot = async () => null;
helpers.resolveBitableAppToken = async () => 'fixture';
helpers.fetchBitableRecords = async (_http, options) => {
  if (options.tableId === 'tblfaa7c2608349c') {
    ++repairReads;
    return repairs;
  }
  return ledger;
};
const repairReader = require('../../server/modules/equipment-lifecycle/equipment-repair-source.reader');
repairReader.fetchEquipmentRepairRecords = async () => {
  ++repairReads;
  return repairs;
};
repairReader.readPersistedRepairSnapshot = async () => null;
repairReader.persistRepairSnapshot = async () => {};
const {
  EquipmentLifecycleModule,
} = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.module');
const {
  EquipmentLedgerService,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
const {
  EquipmentLifecycleService,
} = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.service');
const {
  UnifiedAccessGuard,
} = require('../../server/common/access/unified-access.guard');
const {
  UnifiedAccessService,
} = require('../../server/common/access/unified-access.service');
const {
  mapEquipmentLifecycleDashboard,
} = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.mapper');
const principals = Object.fromEntries(
  floors.map((purchaseBuilding, i) => [
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
class InventoryGuardProbe {
  overview() {
    return { fixture: true };
  }
  confirm() {
    return { fixture: true };
  }
  undo() {
    return { fixture: true };
  }
  retry() {
    return { fixture: true };
  }
  wrongMethod() {
    return { fixture: true };
  }
  nearby() {
    return { fixture: true };
  }
}
class EquipmentMethodProbe {
  denied() {
    return { fixture: true };
  }
}
Controller('api/equipment-ledger')(EquipmentMethodProbe);
for (const route of ['history-devices', 'lifecycle-dashboard']) {
  const name = route.replace('-', '_');
  EquipmentMethodProbe.prototype[name] = function () {
    return { fixture: true };
  };
  Post(route)(
    EquipmentMethodProbe.prototype,
    name,
    Object.getOwnPropertyDescriptor(EquipmentMethodProbe.prototype, name),
  );
}
Controller('api/inventory-management/stocktake')(InventoryGuardProbe);
for (const [method, route, action] of [
  [Get, 'overview', 'overview'],
  [Post, 'bulk-confirm', 'confirm'],
  [Post, 'bulk-undo', 'undo'],
  [Post, 'retry-sync', 'retry'],
  [Get, 'bulk-confirm', 'wrongMethod'],
  [Post, 'bulk-confirm/extra', 'nearby'],
])
  method(route)(
    InventoryGuardProbe.prototype,
    action,
    Object.getOwnPropertyDescriptor(InventoryGuardProbe.prototype, action),
  );
(async () => {
  const runtime = await Test.createTestingModule({
    imports: [EquipmentLifecycleModule],
    controllers: [InventoryGuardProbe, EquipmentMethodProbe],
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
      getDashboard: async (_refresh, building) => {
        lifecycleReads++;
        const rows = ledger.map((record, i) => ({
          ...record,
          fields: {
            ...record.fields,
            楼栋: floors[i],
            状态: '未到期',
            合同当前状态: '在保',
          },
        }));
        const sources = Object.fromEntries(
          [
            'equipment',
            'keyParts',
            'longTermMaintenance',
            'maintenanceContracts',
          ].map((k) => [k, { records: rows, status: 'fresh' }]),
        );
        return mapEquipmentLifecycleDashboard(sources, {
          month: '2026-10',
          syncedAt: '2026-10-03T00:00:00Z',
          building,
        });
      },
    })
    .compile();
  const app = runtime.createNestApplication();
  try {
    await runtime.get(EquipmentLedgerService).getDashboard();
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const get = async (token, assetId, refresh) => {
      const r = await fetch(
        `${url}/api/equipment-ledger/history?${new URLSearchParams({ ...(assetId === undefined ? {} : { assetId }), ...(refresh ? { refresh: '1' } : {}) })}`,
        { headers: token ? { cookie: `fixture_session=${token}` } : {} },
      );
      return {
        status: r.status,
        body: await r.json(),
        cache: r.headers.get('cache-control'),
      };
    };
    for (const token of ['supervisor-0', 'guest', 'inventory_admin', 'station'])
      check(
        (await get(token, 'asset-1')).status,
        token === 'supervisor-0' ? 404 : 403,
      );
    check(repairReads, 0);
    const endpoint = async (token, name, params = '', method = 'GET') => {
      const r = await fetch(`${url}/api/equipment-ledger/${name}${params}`, {
        method,
        headers: token ? { cookie: `fixture_session=${token}` } : {},
      });
      return {
        status: r.status,
        body: await r.json(),
        cache: r.headers.get('cache-control'),
      };
    };
    for (const name of ['history-devices', 'lifecycle-dashboard']) {
      for (const token of [
        '',
        'guest',
        'inventory_admin',
        'station',
        'purchase_admin',
        'purchase_applicant',
        'duty_editor',
        'construction_admin',
        'supply_chain_admin',
      ]) {
        check((await endpoint(token, name)).status, 403);
      }
      for (let i = 0; i < 5; i++)
        check(
          (await endpoint(`supervisor-${i}`, name, '', 'POST')).status,
          403,
        );
    }
    check(repairReads, 0);
    check(lifecycleReads, 0);
    check(
      (await endpoint('supervisor-0', 'lifecycle-dashboard', '?building=B楼'))
        .status,
      403,
    );
    check(
      (await endpoint('admin', 'lifecycle-dashboard', '?building=110站'))
        .status,
      400,
    );
    check(lifecycleReads, 0);
    for (const token of [
      'admin',
      'editor',
      ...floors.map((_, i) => `supervisor-${i}`),
    ]) {
      const expectedFloors = token.startsWith('supervisor')
        ? [floors[Number(token.slice(-1))]]
        : floors;
      const response = await endpoint(token, 'lifecycle-dashboard');
      check(response.status, 200);
      check(response.cache, 'no-store');
      check(
        [...new Set(response.body.assets.map((a) => a.building))],
        expectedFloors,
      );
      check(response.body.summary.equipmentTotal, expectedFloors.length);
      check(
        response.body.sourceTables.every(
          (t) => t.recordCount === expectedFloors.length,
        ),
        true,
      );
      const devices = await endpoint(token, 'history-devices');
      if (devices.body.status === 'loading')
        await new Promise((resolve) => setImmediate(resolve));
      const readyDevices =
        devices.body.status === 'loading'
          ? await endpoint(token, 'history-devices')
          : devices;
      check(readyDevices.status, 200);
      check(readyDevices.cache, 'no-store');
      check(readyDevices.body.status, 'ready');
      check(
        readyDevices.body.devices.map((d) => d.asset.building),
        expectedFloors,
      );
      check(
        readyDevices.body.devices.reduce((n, d) => n + d.completed, 0),
        expectedFloors.filter((b) => b !== 'A楼').length,
      );
      check(
        readyDevices.body.devices.reduce((n, d) => n + d.pending, 0),
        expectedFloors.includes('A楼') ? 1 : 0,
      );
    }
    check((await get('', 'asset-0')).status, 403);
    check((await get('admin', undefined)).status, 400);
    await get('admin', 'asset-0');
    for (const token of [
      'admin',
      'editor',
      ...floors.map((_, i) => `supervisor-${i}`),
    ]) {
      const allowed = token.startsWith('supervisor')
        ? [Number(token.slice(-1))]
        : [0, 1, 2, 3, 4];
      for (const i of allowed) {
        const response = await get(token, `asset-${i}`);
        check(response.status, 200);
        check(response.cache, 'no-store');
        check(
          response.body.items.map((r) => r.id),
          [`repair-${i}`],
        );
        check(response.body.items[0].status, i ? '维修完成' : '未开始');
        check(response.body.items[0].fault, `${floors[i]}故障`);
        check(
          Object.keys(response.body).sort(),
          [
            'assetId',
            'error',
            'items',
            'refreshing',
            'stale',
            'status',
            'updatedAt',
          ].sort(),
        );
      }
    }
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++)
        if (i !== j)
          check((await get(`supervisor-${i}`, `asset-${j}`)).status, 404);
    for (const token of [
      'guest',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
      'duty_editor',
      'construction_admin',
      'supply_chain_admin',
      'station',
    ])
      check((await get(token, 'asset-0')).status, 403);
    check(repairReads, 1);
    let inventoryChecks = 0;
    for (const token of [
      'inventory_admin',
      'supervisor-0',
      'guest',
      'purchase_admin',
      'duty_editor',
      'construction_admin',
    ]) {
      for (const [method, route, allowed] of [
        ['GET', 'overview', true],
        ['POST', 'bulk-confirm', true],
        ['POST', 'bulk-undo', true],
        ['POST', 'retry-sync', true],
        ['GET', 'bulk-confirm', false],
        ['POST', 'bulk-confirm/extra', false],
      ]) {
        const result = await fetch(
          `${url}/api/inventory-management/stocktake/${route}`,
          { method, headers: { cookie: `fixture_session=${token}` } },
        );
        const authorized =
          allowed && ['inventory_admin', 'supervisor-0'].includes(token);
        check(result.status, authorized ? (method === 'GET' ? 200 : 201) : 403);
        ++inventoryChecks;
      }
    }
    const guardPath = path.join(
      root,
      'server/common/access/unified-access.guard.ts',
    );
    const out = path.join(root, 'output/equipment-ledger-20261003-check');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'http-permissions.json'),
      JSON.stringify(
        {
          checks,
          inventoryChecks,
          repairReads,
          lifecycleReads,
          checkedAt: new Date().toISOString(),
          command: 'node test/integration/equipment-history-permissions.cjs',
          files: [
            'server/common/access/unified-access.guard.ts',
            'server/modules/equipment-lifecycle/equipment-lifecycle.module.ts',
            'server/modules/equipment-lifecycle/equipment-ledger.controller.ts',
            'server/modules/equipment-lifecycle/equipment-ledger-access.ts',
            'server/modules/equipment-lifecycle/equipment-ledger.service.ts',
            'server/modules/equipment-lifecycle/equipment-ledger.model.ts',
            'server/modules/equipment-lifecycle/equipment-history.service.ts',
            'server/modules/equipment-lifecycle/equipment-history.model.ts',
            'server/modules/equipment-lifecycle/equipment-repair-source.service.ts',
            'server/modules/equipment-lifecycle/equipment-lifecycle.mapper.ts',
            'test/integration/equipment-history-permissions.cjs',
          ].map((file) => ({
            file,
            sha256: crypto
              .createHash('sha256')
              .update(fs.readFileSync(path.join(root, file)))
              .digest('hex'),
          })),
          guardSha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(guardPath))
            .digest('hex'),
          status: 'PASS',
        },
        null,
        2,
      ),
    );
    console.log(
      `HISTORY_HTTP_PASS checks=${checks} inventoryChecks=${inventoryChecks} repairReads=${repairReads}`,
    );
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
