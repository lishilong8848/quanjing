// Read-only timing of the actual persisted full ledger; live refresh is withheld.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  baseUrl: path.resolve(__dirname, '../..'),
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const helper = require('../../server/common/feishu/bitable-direct-read');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
let reads = 0;
const phases = [];
const readDisk = helper.readLatestPersistedBitableRecordSnapshot;
helper.readLatestPersistedBitableRecordSnapshot = async (options) => {
  const started = performance.now();
  const result = await readDisk(options);
  phases.push({
    phase: options.fieldNames.includes('楼栋标识')
      ? 'current-disk'
      : 'legacy-disk',
    elapsedMs: performance.now() - started,
  });
  return result;
};
helper.resolveBitableAppToken = async () => 'withheld-source';
helper.fetchBitableRecords = async () => {
  reads++;
  return new Promise(() => {});
};
const model = require('../../server/modules/equipment-lifecycle/equipment-ledger.model');
for (const name of ['mapLedgerRecords', 'summarizeLedger']) {
  const original = model[name];
  model[name] = (...args) => {
    const start = performance.now();
    const value = original(...args);
    phases.push({ phase: name, elapsedMs: performance.now() - start });
    return value;
  };
}
const {
  EquipmentLedgerService,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
(async () => {
  const service = new EquipmentLedgerService({}, {});
  const build = service.build.bind(service);
  service.build = (...args) => {
    const start = performance.now();
    const value = build(...args);
    phases.push({ phase: 'model', elapsedMs: performance.now() - start });
    return value;
  };
  const started = performance.now();
  const state = await service.getDashboardState();
  const firstMs = performance.now() - started;
  assert.equal(
    state.status,
    'ready',
    'actual old-projection disk snapshot was not restored',
  );
  assert(state.dashboard.overview.metrics.total > 39000);
  console.log(JSON.stringify({ firstMs, phases }));
  assert(firstMs < 2000, `disk restore exceeded two seconds: ${firstMs}`);
  const listStart = performance.now();
  const list = await service.getItems({ pageSize: 20 });
  const listMs = performance.now() - listStart;
  assert.equal(list.snapshotId, state.dashboard.snapshotId);
  const secondStart = performance.now();
  await service.getDashboardState(true);
  const refreshMs = performance.now() - secondStart;
  assert.equal(reads, 1);
  const files = [
    'server/common/feishu/bitable-direct-read.ts',
    'server/modules/equipment-lifecycle/equipment-ledger.service.ts',
    'server/modules/equipment-lifecycle/equipment-ledger.model.ts',
    'shared/equipment-ledger-classification.ts',
    'test/visual/equipment-ledger-startup-check.cjs',
  ];
  const result = {
    status: 'passed',
    firstMs,
    listMs,
    refreshMs,
    total: list.total,
    stale: state.dashboard.stale,
    updatedAt: state.dashboard.updatedAt,
    externalRequests: 0,
    sourceWithheld: true,
    sourceReads: reads,
    files: files.map((file) => ({
      file,
      sha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex'),
    })),
  };
  const out = path.resolve('output/equipment-ledger-20261003-check');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, 'startup-timing.json'),
    JSON.stringify(result, null, 2),
  );
  fs.writeFileSync(
    path.join(out, 'dashboard.json'),
    JSON.stringify(state.dashboard),
  );
  console.log(JSON.stringify({ ...result, files: undefined }));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
