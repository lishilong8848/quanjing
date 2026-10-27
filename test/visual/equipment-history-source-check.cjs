const fs = require('node:fs');
const path = require('node:path');
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
  fetchBitableRecords,
  getTenantAccessToken,
} = require('../../server/common/feishu/bitable-direct-read');
const {
  EquipmentRepairSourceService,
  EQUIPMENT_REPAIR_FIELDS,
} = require('../../server/modules/equipment-lifecycle/equipment-repair-source.service');
const {
  fetchEquipmentRepairRecords,
  persistRepairSnapshot,
} = require('../../server/modules/equipment-lifecycle/equipment-repair-source.reader');
const {
  mapEquipmentRepair,
  matchEquipmentRepair,
} = require('../../server/modules/equipment-lifecycle/equipment-history.model');
const {
  mapLedgerRecords,
} = require('../../server/modules/equipment-lifecycle/equipment-ledger.model');
const out = path.join(root, 'output/equipment-history-check');
fs.mkdirSync(out, { recursive: true });
const http = new HttpService();
const requests = [];
http.axiosRef.interceptors.request.use((config) => {
  const pathname = new URL(config.url).pathname;
  if (
    String(config.method).toLowerCase() !== 'get' &&
    !(
      String(config.method).toLowerCase() === 'post' &&
      (/auth\//.test(pathname) || /\/records\/search$/.test(pathname))
    )
  )
    throw new Error('Read-only check blocked a write');
  config.__phase = /auth\//.test(pathname) ? 'auth' : 'read';
  return config;
});
http.axiosRef.interceptors.response.use(
  (r) => {
    requests.push({
      phase: r.config.__phase,
      status: r.status,
      code: r.data?.code,
    });
    return r;
  },
  (e) => {
    requests.push({
      phase: e.config?.__phase,
      status: e.response?.status,
      code: e.response?.data?.code,
    });
    return Promise.reject(e);
  },
);
const timer = setTimeout(() => {
  console.log('SOURCE_TIMEOUT');
  process.exit(2);
}, 90000);
(async () => {
  const records = await fetchEquipmentRepairRecords(http);
  await persistRepairSnapshot(records, Date.now());
  if (process.argv.includes('--probe-v3')) {
    const token = await getTenantAccessToken(http);
    const result = await http.axiosRef.get(
      'https://open.feishu.cn/open-apis/base/v3/bases/RR4Sbm81xaII07sW0kacCb9xnih/tables/tblschT48zXwigUG/records',
      {
        params: { field_id: 'fldHtTMpGm', limit: 200, offset: 0 },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      },
    );
    fs.writeFileSync(
      path.join(out, 'v3-probe.json'),
      JSON.stringify(result.data),
    );
    console.log(
      JSON.stringify({
        code: result.data.code,
        keys: Object.keys(result.data),
        dataKeys: Object.keys(result.data.data || {}),
      }),
    );
    return;
  }
  const ledger = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'output/equipment-history-card-planning/full-audit-2026-10-02/ledger.json',
      ),
      'utf8',
    ),
  );
  const aliases = new Map(
    ledger.records.map((r) => [r.id, r.fields['楼栋标识']]),
  );
  const assets = mapLedgerRecords(ledger.records).map((a) => ({
    ...a,
    buildingAlias: aliases.get(a.id),
  }));
  const matched = matchEquipmentRepair(assets, records);
  fs.writeFileSync(
    path.join(out, 'live-repair-source.json'),
    JSON.stringify({ records }),
  );
  const accepted = [...matched.values()].filter((r) => r.assetId);
  const completed = records.filter(
    (r) =>
      matched.get(r.record_id || r.id)?.assetId &&
      mapEquipmentRepair(r).status === '维修完成',
  ).length;
  const source = new EquipmentRepairSourceService(http);
  const warm = await source.getState();
  const proof = {
    status:
      accepted.length === 61 && completed === 54 && warm.snapshot
        ? 'PASS'
        : 'MISMATCH',
    rows: records.length,
    linked: accepted.length,
    devices: new Set(accepted.map((r) => r.assetId)).size,
    completed,
    cachedReady: Boolean(warm.snapshot),
    requests,
    externalWrites: 0,
  };
  fs.writeFileSync(
    path.join(out, 'live-source-proof.json'),
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
  if (proof.status !== 'PASS') process.exitCode = 1;
})()
  .catch((e) => {
    fs.writeFileSync(
      path.join(out, 'live-source-proof.json'),
      JSON.stringify({
        status: 'ERROR',
        requests,
        message: 'Runtime source read failed',
      }),
    );
    console.log(
      `SOURCE_FAIL ${e instanceof Error && !('config' in e) ? e.message : 'Runtime read failed'}`,
    );
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(timer));
