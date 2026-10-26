// Read-only check: never creates a stocktake sheet or writes an external record.
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'CommonJS',
    moduleResolution: 'node',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  },
});
require('tsconfig-paths').register({
  baseUrl: root,
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const fs = require('node:fs');
const startedAt = Date.now();
const requests = [];
const output = path.resolve(
  root,
  process.argv
    .find((arg) => arg.startsWith('--output='))
    ?.slice('--output='.length) ||
    'output/inventory-stocktake-dev-check/source-diagnostic.json',
);
function report(data) {
  const result = {
    ...data,
    elapsedMs: Date.now() - startedAt,
    externalWrites: 0,
    requests,
  };
  result.fingerprints =
    require('../fixtures/inventory-stocktake-evidence.cjs').fingerprintSources([
      'server/modules/inventory-management/inventory-stocktake.source.ts',
      'server/modules/inventory-management/inventory-stocktake.rules.ts',
      'server/modules/purchase-inventory/purchase-application.service.ts',
      'test/visual/inventory-stocktake-source-check.cjs',
      'client/src/pages/InventoryManagement/inventory-stocktake.logic.ts',
    ]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      ...result,
      fingerprints: { files: result.fingerprints.files.length },
    }),
  );
}
const { HttpService } = require('@nestjs/axios');
const {
  InventoryWorkflowGateway,
} = require('../../server/modules/inventory-management/inventory-workflow.gateway.ts');
const {
  InventoryStocktakeSource,
} = require('../../server/modules/inventory-management/inventory-stocktake.source.ts');
const {
  selectStocktakeItems,
  stocktakeMonth,
} = require('../../server/modules/inventory-management/inventory-stocktake.rules.ts');
const {
  WAREHOUSE_BUILDINGS,
} = require('../../shared/inventory-management.interface.ts');
const timer = setTimeout(() => {
  report({
    status: 'unverified',
    reason: 'read-only source check exceeded 60 seconds',
  });
  process.exit(2);
}, 60000);
(async () => {
  const http = new HttpService();
  http.axiosRef.interceptors.request.use((config) => {
    const url = new URL(config.url);
    const method = (config.method || 'get').toLowerCase();
    const phase = url.pathname.includes('auth/')
      ? 'authentication'
      : url.pathname.includes('wiki/')
        ? 'wiki-resolution'
        : /\/(search|batch_get)$/.test(url.pathname)
          ? 'record-search'
          : 'records-read';
    if (
      method !== 'get' &&
      !(
        method === 'post' && ['authentication', 'record-search'].includes(phase)
      )
    )
      throw new Error('read-only diagnostic blocked a write');
    config.__diagnostic = {
      phase,
      startedAt: Date.now(),
      timeoutMs: config.timeout,
    };
    return config;
  });
  http.axiosRef.interceptors.response.use(
    (response) => {
      const meta = response.config.__diagnostic;
      requests.push({
        phase: meta.phase,
        elapsedMs: Date.now() - meta.startedAt,
        status: response.status,
        apiCode: response.data?.code ?? null,
        timeoutMs: meta.timeoutMs,
      });
      return response;
    },
    (error) => {
      const meta = error.config?.__diagnostic;
      requests.push({
        phase: meta?.phase || 'unknown',
        elapsedMs: meta ? Date.now() - meta.startedAt : null,
        code: error.code || null,
        status: error.response?.status || null,
        apiCode: error.response?.data?.code ?? null,
        timeoutMs: meta?.timeoutMs,
      });
      return Promise.reject(error);
    },
  );
  const source = new InventoryStocktakeSource(
    http,
    new InventoryWorkflowGateway(http),
  );
  const diagnosticRecord = process.argv
    .find((arg) => arg.startsWith('--record-id='))
    ?.slice('--record-id='.length);
  if (diagnosticRecord) {
    const config = await source.config();
    const record = await source.gateway.getRecord(
      config.appToken,
      process.env.FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID,
      diagnosticRecord,
      '出库填写',
    );
    const names = [
      '物品类别号',
      '物品类别号（单选）',
      '名称',
      '规格型号、设备序列号',
      '楼栋',
      '存放位置',
      '存放位置（程序）',
      '出库时间',
      '程序出库状态',
    ];
    report({
      status: 'diagnostic',
      fields: Object.fromEntries(
        names
          .filter((k) => k in record.fields)
          .map((k) => [k, record.fields[k]]),
      ),
    });
    return;
  }
  const snapshot = await source.snapshot(
    process.argv.includes('--snapshot-only') ? undefined : 'A楼',
  );
  if (process.argv.includes('--warehouse-groups')) {
    const {
      stocktakeWarehouse,
    } = require('../../client/src/pages/InventoryManagement/inventory-stocktake.logic.ts');
    const groups = new Map();
    for (const item of snapshot.items) {
      const name = stocktakeWarehouse(item.location),
        key = `${item.building}:${name}`;
      const group = groups.get(key) || {
        building: item.building,
        name,
        count: 0,
        locations: [],
      };
      group.count++;
      if (
        group.locations.length < 2 &&
        !group.locations.includes(item.location)
      )
        group.locations.push(item.location);
      groups.set(key, group);
    }
    report({
      status: 'passed',
      inventory: snapshot.items.length,
      warehouses: [...groups.values()],
    });
    return;
  }
  const results = WAREHOUSE_BUILDINGS.map((building) => {
    try {
      const result = selectStocktakeItems({
        ...snapshot,
        building,
        month: stocktakeMonth(),
        history: [],
        seed: 'read-only-verification',
      });
      return {
        building,
        inventory: snapshot.items.filter((i) => i.building === building).length,
        selected: result.selected.length,
        random: result.randomTarget,
        moved: result.selected.filter((i) => i.reasons.includes('movement'))
          .length,
        status: 'passed',
      };
    } catch (error) {
      const id = /出入库记录 (\S+)/.exec(error.message)?.[1];
      const movement = snapshot.movements.find((m) => m.recordId === id);
      const skuMatches = movement
        ? snapshot.items.filter(
            (i) => i.building === building && i.sku === movement.sku,
          )
        : [];
      return {
        building,
        status: 'blocked',
        reason: error.message,
        matchDiagnostic: movement
          ? {
              type: movement.type,
              sku: movement.sku,
              location: movement.location,
              skuMatches: skuMatches.map((i) => ({
                recordId: i.recordId,
                location: i.location,
              })),
              otherBuildingMatches: snapshot.items.filter(
                (i) => i.sku === movement.sku && i.building !== building,
              ).length,
            }
          : null,
      };
    }
  });
  if (process.argv.includes('--snapshot-only')) {
    const passed = results.every((r) => r.status === 'passed');
    report({
      status: passed ? 'passed' : 'blocked',
      month: stocktakeMonth(),
      results,
      snapshotOnly: true,
    });
    if (!passed) process.exitCode = 2;
    return;
  }
  let peopleCheck = { status: 'not-run' };
  const currentChecks = [];
  for (const building of WAREHOUSE_BUILDINGS) {
    const sample = snapshot.items.find((i) => i.building === building);
    if (!sample) continue;
    try {
      const current = await source.current(sample);
      currentChecks.push({
        building,
        status: 'passed',
        identityMatches: current.recordId === sample.recordId,
      });
    } catch (error) {
      currentChecks.push({
        building,
        status: 'blocked',
        code: error.code || error.name,
      });
    }
  }
  {
    const {
      PurchaseApplicationService,
    } = require('../../server/modules/purchase-inventory/purchase-application.service.ts');
    const people = new PurchaseApplicationService(http);
    const candidates = await people.searchApplicants({ query: '', limit: 2 });
    const canonical = candidates.length
      ? await people.resolveApplicantForBuilding(candidates[0], true)
      : null;
    peopleCheck = {
      status: canonical ? 'passed' : 'empty',
      candidates: candidates.length,
      stableIdentity: Boolean(canonical?.openId && canonical?.recordId),
    };
  }
  const passed =
    results.every((r) => r.status === 'passed') &&
    peopleCheck.status === 'passed' &&
    currentChecks.every((r) => r.status === 'passed');
  report({
    status: passed ? 'passed' : 'blocked',
    month: stocktakeMonth(),
    results,
    peopleCheck,
    currentChecks,
  });
  if (!passed) process.exitCode = 2;
})()
  .catch((error) => {
    report({
      status: 'unverified',
      reason: error.code || error.name || 'source unavailable',
      statusCode: error.response?.status || null,
      apiCode: error.response?.data?.code ?? null,
    });
    process.exitCode = 2;
  })
  .finally(() => clearTimeout(timer));
