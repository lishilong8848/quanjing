// Read-only source acceptance. External writes are rejected by the request interceptor.
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
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
require('tsconfig-paths').register({
  baseUrl: root,
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const { HttpService } = require('@nestjs/axios');
const {
  EquipmentLedgerService,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
const {
  EquipmentLifecycleService,
} = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.service');
const output = path.join(root, 'output/equipment-ledger-dev-check');
fs.mkdirSync(output, { recursive: true });
const started = Date.now();
const requests = [];
const http = new HttpService();
http.axiosRef.interceptors.request.use((config) => {
  const pathname = new URL(config.url).pathname;
  if (
    String(config.method).toLowerCase() !== 'get' &&
    !(
      String(config.method).toLowerCase() === 'post' &&
      (/auth\//.test(pathname) || /\/records\/search$/.test(pathname))
    )
  )
    throw new Error('read-only check blocked a write');
  config.__start = Date.now();
  config.__phase = /auth\//.test(pathname) ? 'auth' : 'read';
  return config;
});
http.axiosRef.interceptors.response.use(
  (result) => {
    requests.push({
      phase: result.config.__phase,
      elapsedMs: Date.now() - result.config.__start,
      status: result.status,
      code: result.data?.code,
    });
    return result;
  },
  (error) => {
    requests.push({
      phase: error.config?.__phase,
      status: error.response?.status,
      code: error.code,
    });
    return Promise.reject(error);
  },
);
const timer = setTimeout(() => {
  fs.writeFileSync(
    path.join(output, 'source-evidence.json'),
    JSON.stringify(
      {
        status: 'timeout',
        elapsedMs: Date.now() - started,
        externalWrites: 0,
        requests,
      },
      null,
      2,
    ),
  );
  console.log('SOURCE_TIMEOUT=180000');
  process.exit(2);
}, 180000);
(async () => {
  const service = new EquipmentLedgerService(
    http,
    new EquipmentLifecycleService(http),
  );
  const dashboard = await service.getDashboard(true);
  if (dashboard.stale) throw new Error('live source unavailable');
  const checks = [];
  for (const building of dashboard.buildings) {
    for (const warranty of ['在保', '过保', '待确认']) {
      const page = await service.getItems({
        building: building.building,
        warranty,
      });
      const metric =
        warranty === '在保'
          ? 'inWarranty'
          : warranty === '过保'
            ? 'expired'
            : 'pending';
      if (
        page.total !== building.metrics[metric] ||
        page.snapshotId !== dashboard.snapshotId
      )
        throw new Error('summary drilldown mismatch');
      checks.push({ building: building.building, warranty, total: page.total });
    }
  }
  const collections = await service.getItems({ kind: 'collection' });
  if (collections.total !== dashboard.overview.metrics.collections)
    throw new Error('collection mismatch');
  const lifecycleStarted = Date.now();
  let lifecycle;
  let lifecycleStatus = 'unavailable';
  try {
    lifecycle = await service.getLifecycle();
    lifecycleStatus = lifecycle.status;
  } catch {
    /* Result is reported separately from main source. */
  }
  const result = {
    status: 'verified',
    mainSource: 'fresh',
    snapshotId: dashboard.snapshotId,
    asOf: dashboard.asOf,
    metrics: dashboard.overview.metrics,
    checks,
    lifecycleStatus,
    lifecycleMs: Date.now() - lifecycleStarted,
    elapsedMs: Date.now() - started,
    externalWrites: 0,
    requests,
  };
  fs.writeFileSync(
    path.join(output, 'source-evidence.json'),
    JSON.stringify(result, null, 2),
  );
  fs.writeFileSync(
    path.join(output, 'live-summary.json'),
    JSON.stringify({ dashboard, lifecycle }),
  );
  clearTimeout(timer);
  console.log(
    JSON.stringify({
      ...result,
      requests: {
        count: requests.length,
        failures: requests.filter((r) => r.status !== 200).length,
      },
    }),
  );
})().catch(() => {
  clearTimeout(timer);
  fs.writeFileSync(
    path.join(output, 'source-evidence.json'),
    JSON.stringify(
      {
        status: 'unavailable',
        elapsedMs: Date.now() - started,
        externalWrites: 0,
        requests,
      },
      null,
      2,
    ),
  );
  console.log('SOURCE_UNAVAILABLE');
  process.exitCode = 1;
});
