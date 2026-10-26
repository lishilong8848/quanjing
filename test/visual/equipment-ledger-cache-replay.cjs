// Replay the exact successful live snapshot with current mapper bytes, without more external requests.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
const {
  readLatestPersistedBitableRecordSnapshot,
} = require('../../server/common/feishu/bitable-direct-read');
const {
  EQUIPMENT_LEDGER_FIELDS,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
const {
  mapLedgerRecords,
  summarizeLedger,
  queryLedger,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.model');
const output = path.join(root, 'output/equipment-ledger-dev-check');
const replayOutput =
  process.argv[2] === 'revision-3'
    ? path.join(root, 'output/equipment-ledger-revision-3-check')
    : process.argv[2] === 'revision-2'
      ? path.join(root, 'output/equipment-ledger-revision-2-check')
      : output;
fs.mkdirSync(replayOutput, { recursive: true });
(async () => {
  const source = JSON.parse(
    fs.readFileSync(path.join(output, 'source-evidence.json'), 'utf8'),
  );
  const snapshot = await readLatestPersistedBitableRecordSnapshot({
    tableId: 'tbld39d3db603982',
    tableName: '南通各机楼设备台账',
    appToken: 'WMcQbPn71aXwoGsNv0vcnzz2n6c',
    fieldNames: EQUIPMENT_LEDGER_FIELDS,
  });
  if (!snapshot || source.status !== 'verified')
    throw new Error('verified source snapshot missing');
  const snapshotId = crypto
    .createHash('sha256')
    .update(JSON.stringify({ records: snapshot.records, asOf: source.asOf }))
    .digest('hex');
  if (snapshotId !== source.snapshotId)
    throw new Error('source snapshot fingerprint mismatch');
  const started = Date.now();
  const assets = mapLedgerRecords(snapshot.records, source.asOf);
  const overview = summarizeLedger(assets);
  const buildings = [...new Set(assets.map((asset) => asset.building))]
    .sort()
    .map((building) => summarizeLedger(assets, building));
  const checks = [];
  const familyChecks = [];
  for (const summary of [overview, ...buildings]) {
    const scope = summary === overview ? {} : { building: summary.building };
    for (const point of summary.families) {
      const count = queryLedger(assets, { ...scope, family: point.name }).total;
      if (
        count !== point.count ||
        point.inWarranty + point.expired + point.pending !== count
      )
        throw new Error('family summary drilldown mismatch');
      familyChecks.push({
        building: summary.building,
        family: point.name,
        count,
      });
    }
    for (const point of summary.systems) {
      if (
        queryLedger(assets, { ...scope, system: point.name }).total !==
          point.count ||
        point.families.length !== point.kindCount
      )
        throw new Error('system composition mismatch');
    }
    if (
      summary.systems.reduce((n, p) => n + p.count, 0) !== summary.metrics.total
    )
      throw new Error('system total mismatch');
    if (
      summary.systems.reduce((n, p) => n + p.kindCount, 0) !==
      summary.families.length
    )
      throw new Error('system kind duplication');
  }
  for (const summary of buildings) {
    for (const [warranty, metric] of [
      ['在保', 'inWarranty'],
      ['过保', 'expired'],
      ['待确认', 'pending'],
    ]) {
      const count = queryLedger(assets, {
        building: summary.building,
        warranty,
      }).total;
      if (count !== summary.metrics[metric])
        throw new Error('summary drilldown mismatch');
      checks.push({ building: summary.building, warranty, count });
    }
  }
  const files = [
    'server/modules/equipment-lifecycle/equipment-ledger.model.ts',
    'server/modules/equipment-lifecycle/equipment-ledger.service.ts',
    'shared/equipment-ledger.interface.ts',
    'shared/equipment-ledger-classification.ts',
  ];
  const evidence = {
    status: 'verified',
    sourceSnapshotId: snapshotId,
    sourceFetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    externalRequests: 0,
    metrics: overview.metrics,
    checks,
    familyChecks,
    composition: overview.systems,
    elapsedMs: Date.now() - started,
    files: files.map((file) => ({
      file,
      sha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex'),
    })),
  };
  fs.writeFileSync(
    path.join(replayOutput, 'cache-replay-evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  fs.writeFileSync(
    path.join(replayOutput, 'normalized-live-summary.json'),
    JSON.stringify({
      snapshotId,
      updatedAt: new Date(snapshot.fetchedAt).toISOString(),
      asOf: source.asOf,
      stale: false,
      overview,
      buildings,
    }),
  );
  console.log(
    JSON.stringify({
      status: evidence.status,
      metrics: evidence.metrics,
      buildings: buildings.map((s) => s.building),
      elapsedMs: evidence.elapsedMs,
      externalRequests: 0,
      composition: overview.systems.map((p) => ({
        name: p.name,
        kinds: p.kindCount,
        records: p.count,
      })),
    }),
  );
})().catch((error) => {
  console.log(error.message);
  process.exitCode = 1;
});
