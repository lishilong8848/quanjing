// Read-only diagnostic: no stocktake mutation, external write or notification.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const output = path.join(
  root,
  'output/inventory-stocktake-bulk-check-20261016',
);
const cache = path.join(output, 'private-cache');
fs.mkdirSync(output, { recursive: true });
process.env.FEISHU_LOCAL_CACHE_DIR = cache;
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
const { HttpService } = require('@nestjs/axios');
const {
  PurchaseApplicationService,
} = require('../../server/modules/purchase-inventory/purchase-application.service');
const {
  InventoryStocktakeSource,
} = require('../../server/modules/inventory-management/inventory-stocktake.source');
const {
  InventoryWorkflowGateway,
} = require('../../server/modules/inventory-management/inventory-workflow.gateway');
const {
  extractDisplayText,
  extractNumberValue,
  pickField,
} = require('../../server/common/feishu/bitable-direct-read');
const requests = [],
  stages = [];
let stage = '';
const started = Date.now();
const http = new HttpService();
http.axiosRef.interceptors.request.use((config) => {
  const pathname = new URL(config.url).pathname;
  const method = (config.method || 'get').toUpperCase();
  const phase = pathname.includes('/auth/')
    ? 'auth'
    : pathname.includes('/wiki/')
      ? 'wiki'
      : 'records';
  if (
    method !== 'GET' &&
    !(
      method === 'POST' &&
      (phase === 'auth' || /\/(search|batch_get)$/.test(pathname))
    )
  )
    throw new Error('READ_ONLY_GUARD');
  config.__probe = {
    stage,
    phase,
    started: Date.now(),
    requestedRecords: config.data?.record_ids?.length,
  };
  return config;
});
function requestResult(config, status, data, code) {
  const meta = config?.__probe;
  requests.push({
    stage: meta?.stage,
    phase: meta?.phase,
    elapsedMs: Date.now() - (meta?.started || Date.now()),
    status: status || null,
    apiCode: data?.code ?? null,
    code: code || null,
    requestedRecords: meta?.requestedRecords,
  });
}
http.axiosRef.interceptors.response.use(
  (response) => {
    requestResult(response.config, response.status, response.data);
    return response;
  },
  (error) => {
    requestResult(
      error.config,
      error.response?.status,
      error.response?.data,
      error.code,
    );
    return Promise.reject(error);
  },
);
async function check(name, read) {
  stage = name;
  const start = Date.now();
  try {
    const data = await read();
    stages.push({ name, status: 'ok', elapsedMs: Date.now() - start, ...data });
  } catch (error) {
    stages.push({
      name,
      status: 'error',
      elapsedMs: Date.now() - start,
      errorType: error.constructor?.name,
      httpStatus: error.response?.status || null,
      apiCode: error.response?.data?.code ?? null,
      code: error.code || null,
    });
  }
}
(async () => {
  const people = Object.assign(
    Object.create(PurchaseApplicationService.prototype),
    { httpService: http },
  );
  await check('personnel', async () => {
    const applicants = await people.readActiveApplicants(true);
    const matches = applicants.filter((person) => person.name === '陈继猛');
    const resolved =
      matches.length === 1
        ? await people.resolveApplicantForBuilding(matches[0], true)
        : null;
    return {
      activeCount: applicants.length,
      selectedNameMatches: matches.length,
      selectedPersonVerified: !!resolved,
    };
  });
  const gateway = new InventoryWorkflowGateway(http);
  const source = new InventoryStocktakeSource(http, gateway);
  await check('inventory', async () => {
    const { appToken } = await source.config();
    const targeted = process.argv.includes('--targeted');
    const records = targeted
      ? await gateway.searchRecords({
          appToken,
          tableId: process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID,
          tableName: '库存台账',
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: '楼栋', operator: 'is', value: ['B楼'] },
            ],
          },
        })
      : await gateway.listRecords({
          appToken,
          tableId: process.env.FEISHU_WAREHOUSE_INVENTORY_TABLE_ID,
          tableName: '库存台账',
        });
    const invalid = records.filter((record) => {
      const fields = record.fields || {};
      return !fields['楼栋'] || fields['剩余库存'] == null;
    }).length;
    const previous = targeted
      ? records
          .slice(0, 400)
          .map((record) => ({
            recordId: record.record_id || record.id,
            building: extractDisplayText(
              pickField(record.fields, ['楼栋']),
              '',
            ).trim(),
            sku: extractDisplayText(
              pickField(record.fields, ['物品类别号']),
              '',
            ).trim(),
            quantity: extractNumberValue(
              pickField(record.fields, ['剩余库存']),
            ),
            location: '',
            name: '库存核查条目',
          }))
      : [];
    const current = await source.currentMany(previous);
    return {
      inventoryCount: records.length,
      checkedRecords: current.length,
      missingBuildingOrQuantity: invalid,
    };
  });
})()
  .catch((error) => {
    stages.push({
      name: stage,
      status: 'unexpected-error',
      errorType: error.constructor?.name,
    });
  })
  .finally(() => {
    const resolvedCache = path.resolve(cache);
    if (!resolvedCache.startsWith(path.resolve(output) + path.sep))
      throw new Error('Unsafe diagnostic cache path');
    fs.rmSync(resolvedCache, { recursive: true, force: true });
    const result = {
      externalWrites: 0,
      elapsedMs: Date.now() - started,
      stages,
      requests,
      privateCacheRemoved: !fs.existsSync(cache),
    };
    fs.writeFileSync(
      path.join(
        output,
        process.argv.includes('--targeted')
          ? 'read-probe-targeted.json'
          : 'read-probe.json',
      ),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  });
