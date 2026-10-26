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
if (!['revision-2', 'revision-3', 'permissions'].includes(process.argv[2]))
  throw new Error('Explicit evidence revision is required');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
require('tsconfig-paths').register({
  baseUrl: root,
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const assert = require('node:assert/strict');
const helper = require('../../server/common/feishu/bitable-direct-read');
let resolveRead;
let rejectRead;
let reads = 0;
helper.fetchBitableRecords = () => {
  ++reads;
  return new Promise((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
};
helper.resolveBitableAppToken = async () => 'test-base';
helper.readLatestPersistedBitableRecordSnapshot = async () => null;
helper.createBitableBackgroundRefresh = () => ({ start() {}, stop() {} });
const { Test } = require('@nestjs/testing');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const {
  EquipmentLifecycleModule,
} = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.module');
const {
  EquipmentLedgerService,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
(async () => {
  const app = (
    await Test.createTestingModule({
      imports: [EquipmentLifecycleModule],
    }).compile()
  ).createNestApplication();
  app.use((req, _res, next) => {
    req.accessPrincipal = { role: 'admin', purchaseBuilding: null };
    next();
  });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const service = app.get(EquipmentLedgerService);
    const started = Date.now();
    const first = await fetch(base + '/api/equipment-ledger/dashboard?async=1');
    const firstResponseMs = Date.now() - started;
    assert(
      firstResponseMs < 1000,
      'state response blocked on the withheld source read',
    );
    assert.equal((await first.json()).status, 'loading');
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await (
            await fetch(base + '/api/equipment-ledger/dashboard?async=1')
          ).json()
        ).status,
        'loading',
      );
    assert.equal(reads, 1);
    resolveRead([
      {
        record_id: 'a',
        fields: { 机楼: '南通A楼', 设备名称: 'UPS', 设备编号: 'A-01' },
      },
    ]);
    await service.getDashboard(true);
    await Promise.resolve();
    const ready = await (
      await fetch(base + '/api/equipment-ledger/dashboard?async=1')
    ).json();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.dashboard.overview.metrics.total, 1);
    assert.equal(ready.dashboard.buildings[0].building, 'A楼');
    const refresh = await (
      await fetch(base + '/api/equipment-ledger/dashboard?async=1&refresh=1')
    ).json();
    assert.equal(refresh.refreshing, true);
    assert.equal(refresh.dashboard.snapshotId, ready.dashboard.snapshotId);
    rejectRead(new Error('offline fixture'));
    await service.getDashboard(true);
    const failed = await (
      await fetch(base + '/api/equipment-ledger/dashboard?async=1')
    ).json();
    assert.equal(failed.refreshing, false);
    assert(failed.error);
    assert.equal(failed.dashboard.overview.metrics.total, 1);
    assert.equal(
      (await (await fetch(base + '/api/equipment-ledger/dashboard')).json())
        .snapshotId,
      ready.dashboard.snapshotId,
    );
    const output = path.join(
      root,
      process.argv[2] === 'permissions'
        ? 'output/equipment-ledger-permissions-check'
        : process.argv[2] === 'revision-3'
        ? 'output/equipment-ledger-revision-3-check'
        : 'output/equipment-ledger-revision-2-check',
    );
    fs.mkdirSync(output, { recursive: true });
    const files = [
      'server/modules/equipment-lifecycle/equipment-ledger.service.ts',
      'server/modules/equipment-lifecycle/equipment-ledger.controller.ts',
      'shared/equipment-ledger.interface.ts',
      'test/integration/equipment-ledger-read-state.cjs',
    ];
    const evidence = {
      status: 'passed',
      firstResponseMs,
      withheldSourceRead: true,
      pollsShareOneRead: true,
      polls: 6,
      reads,
      readyTotal: 1,
      refreshFailureRetainsData: true,
      legacyCompatible: true,
      files: files.map((file) => ({
        file,
        sha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(root, file)))
          .digest('hex'),
      })),
    };
    fs.writeFileSync(
      path.join(output, 'read-state-api.json'),
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify({ ...evidence, files: undefined }));
  } finally {
    resolveRead?.([]);
    await app.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
