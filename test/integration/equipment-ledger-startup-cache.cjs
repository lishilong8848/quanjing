'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
if (!process.argv[2]) {
  const started = Date.now();
  for (const mode of ['valid', 'null-record', 'invalid-date', 'offline']) {
    const result = spawnSync(
      process.execPath,
      ['--unhandled-rejections=strict', __filename, mode],
      {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          FEISHU_SUPPLY_CHAIN_BACKGROUND_SYNC_ENABLED: 'false',
        },
      },
    );
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert(result.stdout.includes('INITIALIZATION_AND_READ_VERIFIED'), mode);
  }
  console.log(
    JSON.stringify({
      passed: true,
      realNestInitialization: true,
      strictUnhandledRejections: true,
      cases: 4,
      externalWrites: 0,
      elapsedMs: Date.now() - started,
    }),
  );
} else {
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
    baseUrl: path.resolve(__dirname, '../..'),
    paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
  });
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const helper = require('../../server/common/feishu/bitable-direct-read');
  const rows = [
    {
      record_id: 'startup-regression-only',
      fields: { '\u8bbe\u5907\u540d\u79f0': 'UPS' },
    },
  ];
  const mode = process.argv[2];
  helper.readLatestPersistedBitableRecordSnapshot = async () => ({
    records:
      mode === 'null-record' || mode === 'offline' ? [null, ...rows] : rows,
    fetchedAt: mode === 'invalid-date' ? 1e20 : Date.now(),
  });
  helper.fetchBitableRecords = async () => {
    if (mode === 'offline') throw new Error('Isolated upstream unavailable');
    return rows;
  };
  helper.resolveBitableAppToken = async () => 'isolated-only';
  const { Test } = require('@nestjs/testing');
  const {
    EquipmentLifecycleModule,
  } = require('../../server/modules/equipment-lifecycle/equipment-lifecycle.module');
  const {
    EquipmentLedgerService,
  } = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
  (async () => {
    const runtime = await Test.createTestingModule({
      imports: [EquipmentLifecycleModule],
    }).compile();
    const app = runtime.createNestApplication({ logger: false });
    try {
      await app.init();
      await new Promise((resolve) => setImmediate(resolve));
      const ledger = runtime.get(EquipmentLedgerService);
      if (mode === 'offline') {
        await assert.rejects(
          ledger.getDashboard(),
          (error) => error.getStatus?.() === 503,
        );
      } else {
        assert.equal((await ledger.getDashboard()).overview.metrics.total, 1);
      }
      console.log('INITIALIZATION_AND_READ_VERIFIED');
    } finally {
      await app.close();
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
