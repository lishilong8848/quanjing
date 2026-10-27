// Authorized, resumable migration of association metadata only. No repair business fields are written.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'node' },
});
const root = path.resolve(__dirname, '..');
require('tsconfig-paths').register({
  baseUrl: root,
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const {
  mapLedgerRecords,
} = require('../server/modules/equipment-lifecycle/equipment-ledger.model');
const {
  extractDisplayText,
} = require('../server/common/feishu/bitable-direct-read');
const {
  matchEquipmentRepair,
} = require('../server/modules/equipment-lifecycle/equipment-history.model');
const {
  EQUIPMENT_REPAIR_FIELDS,
} = require('../server/modules/equipment-lifecycle/equipment-repair-source.service');
const cli =
  process.env.LARK_CLI_ENTRY ||
  path.join(
    process.env.LOCALAPPDATA,
    'Programs/nodejs/node_modules/@larksuite/cli/scripts/run.js',
  );
const base = 'RR4Sbm81xaII07sW0kacCb9xnih',
  table = 'tblschT48zXwigUG';
const input = path.resolve(
  root,
  'output/equipment-history-card-planning/full-audit-2026-10-02',
);
const out = path.resolve(root, 'output/equipment-history-check');
fs.mkdirSync(out, { recursive: true });
const sha = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const read = (n) =>
  JSON.parse(fs.readFileSync(path.join(input, n + '.json'), 'utf8'));
const write = (n, v) => {
  const p = path.join(out, n + '.json');
  fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 2));
  fs.renameSync(p + '.tmp', p);
};
const journalPath = path.join(out, 'source-mutation-ledger.json');
const journal = fs.existsSync(journalPath)
  ? JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  : { operations: {}, startedAt: new Date().toISOString() };
async function call(command, args = [], token = base) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, 'base', command, '--base-token', token, '--as', 'user', ...args],
      { windowsHide: true },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `${command}: timeout; inspect pending operation before retry`,
        ),
      );
    }, 45000);
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout || stderr);
        if (!result.ok) throw new Error(`${command}: ${result.error?.code}`);
        resolve(result.data);
      } catch (e) {
        reject(e);
      }
    });
  });
}
function rows(data) {
  if (
    !Array.isArray(data.data) ||
    data.record_id_list?.length !== data.data.length
  )
    throw new Error('Invalid source record envelope');
  return data.data.map((row, i) => ({
    id: data.record_id_list[i],
    fields: Object.fromEntries(data.fields.map((f, j) => [f, row[j]])),
  }));
}
async function all(schema, viewId) {
  const fields = EQUIPMENT_REPAIR_FIELDS.filter((n) =>
    schema.fields.some((f) => f.name === n),
  );
  const ids = fields.map((n) => schema.fields.find((f) => f.name === n).id);
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const page = await call('+record-list', [
      '--table-id',
      table,
      '--format',
      'json',
      '--limit',
      '200',
      '--offset',
      String(offset),
      ...(viewId ? ['--view-id', viewId] : []),
      ...ids.flatMap((id) => ['--field-id', id]),
    ]);
    result.push(...rows(page));
    if (!page.has_more) break;
  }
  if (
    new Set(result.map((r) => r.id)).size !== result.length ||
    JSON.stringify(result).includes('\uFFFD')
  )
    throw new Error('Incomplete or invalid source snapshot');
  return result;
}
async function schema() {
  const value = await call('+field-list', [
    '--table-id',
    table,
    '--limit',
    '200',
  ]);
  if (value.has_more) throw new Error('Incomplete schema');
  return value;
}
const metadata = async (token) => (await call('+table-list', [], token)).tables;
const metadataFields = ['台账关联状态', '台账关联说明', '关联台账记录ID'];
const business = (records) =>
  records.map((r) => ({
    id: r.id,
    fields: Object.fromEntries(
      Object.entries(r.fields).filter(([k]) => !metadataFields.includes(k)),
    ),
  }));
async function intent(key, payload, action) {
  const id = sha({ base, table, key, payload });
  journal.operations[id] = {
    clientMutationId: id,
    key,
    payload,
    status: 'pending',
    at: new Date().toISOString(),
  };
  write('source-mutation-ledger', journal);
  const result = await action();
  journal.operations[id].status = 'accepted';
  write('source-mutation-ledger', journal);
  return result;
}
async function main() {
  const started = Date.now();
  const ledger = read('ledger');
  if (
    sha(ledger.records) !== ledger.sha256 ||
    read('fetch-proof').status !== 'COMPLETE_STABLE'
  )
    throw new Error('Invalid audit input');
  const liveLedger = (await metadata('WMcQbPn71aXwoGsNv0vcnzz2n6c')).find(
    (t) => t.id === 'tblPIgIZ5fyEeQnY',
  );
  if (
    !liveLedger ||
    liveLedger.rev !== ledger.expected.rev ||
    liveLedger.records_count !== ledger.records.length
  )
    throw new Error(
      'Ledger changed since full audit; refresh full ledger before mutation',
    );
  let fields = await schema();
  const beforeMeta = (await metadata(base)).find((t) => t.id === table);
  let current = await all(fields);
  const afterMeta = (await metadata(base)).find((t) => t.id === table);
  if (
    beforeMeta.rev !== afterMeta.rev ||
    current.length !== afterMeta.records_count
  )
    throw new Error('Repair source changed during preflight');
  const alias = new Map(
    ledger.records.map((r) => [r.id, r.fields['楼栋标识']]),
  );
  const assets = mapLedgerRecords(ledger.records).map((a) => ({
    ...a,
    buildingAlias: alias.get(a.id),
  }));
  const matches = matchEquipmentRepair(assets, current, false);
  const old = read('primary-comparison-report').results.filter(
    (r) => r.source === 'current',
  );
  if (
    old.length !== current.length ||
    old.some(
      (r) => matches.get(r.id)?.assetId !== (r.passed ? r.asset.id : null),
    )
  )
    throw new Error(
      'Association results changed; review fresh identities first',
    );
  const accepted = [...matches.values()].filter((r) => r.assetId);
  write('migration-preflight', {
    at: new Date().toISOString(),
    ledgerRev: liveLedger.rev,
    ledgerHash: ledger.sha256,
    repairRev: afterMeta.rev,
    sourceHash: sha(business(current)),
    rows: current.length,
    linked: accepted.length,
    devices: new Set(accepted.map((r) => r.assetId)).size,
  });
  console.log(
    `PREFLIGHT rows=${current.length} linked=${accepted.length} devices=${new Set(accepted.map((r) => r.assetId)).size}`,
  );
  if (!process.argv.includes('--apply')) return;
  const definitions = [
    {
      name: '台账关联状态',
      type: 'select',
      multiple: false,
      options: [
        { name: '已关联', hue: 'Green', lightness: 'Light' },
        { name: '待确认', hue: 'Blue', lightness: 'Lighter' },
      ],
    },
    { name: '台账关联说明', type: 'text' },
    { name: '关联台账记录ID', type: 'text' },
  ];
  for (const def of definitions) {
    const existing = fields.fields.filter((f) => f.name === def.name);
    if (existing.length > 1 || (existing[0] && existing[0].type !== def.type))
      throw new Error('Association field schema conflict');
    if (!existing.length) {
      await intent('field-create:' + def.name, def, () =>
        call('+field-create', [
          '--table-id',
          table,
          '--json',
          JSON.stringify(def),
        ]),
      );
      fields = await schema();
    }
  }
  if (
    !fields.fields
      .find((f) => f.name === '台账关联状态')
      .options.some((o) => o.name === '已关联') ||
    !fields.fields
      .find((f) => f.name === '台账关联状态')
      .options.some((o) => o.name === '待确认')
  )
    throw new Error('Association options conflict');
  current = await all(fields);
  const beforeBusiness = sha(business(current));
  const freshMatches = matchEquipmentRepair(assets, current, false);
  if (
    old.some(
      (r) => freshMatches.get(r.id)?.assetId !== (r.passed ? r.asset.id : null),
    )
  )
    throw new Error('Identity changed before source marking');
  const groups = new Map();
  for (const row of current) {
    const matched = freshMatches.get(row.id);
    const patch = {
      台账关联状态: matched.assetId ? '已关联' : '待确认',
      台账关联说明: matched.assetId ? null : matched.reason,
      关联台账记录ID: matched.assetId || null,
    };
    if (
      Object.entries(patch).every(
        ([key, value]) =>
          (extractDisplayText(row.fields[key]).trim() || null) === value,
      )
    )
      continue;
    const key = JSON.stringify(patch);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.id);
  }
  let written = 0;
  for (const [json, ids] of groups) {
    for (let offset = 0; offset < ids.length; offset += 200) {
      const payload = {
        record_id_list: ids.slice(offset, offset + 200),
        patch: JSON.parse(json),
      };
      const result = await intent('record-metadata', payload, () =>
        call('+record-batch-update', [
          '--table-id',
          table,
          '--json',
          JSON.stringify(payload),
        ]),
      );
      if (result.ignored_fields?.length)
        throw new Error('Metadata write ignored a field');
      written += payload.record_id_list.length;
      if (written % 10 === 0 || written === current.length)
        console.log(`MARKED ${written}`);
    }
  }
  const verified = await all(fields);
  write('source-records-readback', {
    records: verified,
    sha256: sha(verified),
  });
  if (sha(business(verified)) !== beforeBusiness)
    throw new Error(
      'Repair business data changed during migration; recheck before accepting',
    );
  const confirmed = matchEquipmentRepair(assets, verified);
  const mismatch = verified.filter(
    (r) =>
      confirmed.get(r.id)?.assetId !== freshMatches.get(r.id)?.assetId ||
      extractDisplayText(r.fields['台账关联状态']) !==
        (freshMatches.get(r.id).assetId ? '已关联' : '待确认') ||
      (extractDisplayText(r.fields['台账关联说明']) || '') !==
        (freshMatches.get(r.id).assetId ? '' : freshMatches.get(r.id).reason),
  );
  if (verified.length !== current.length || mismatch.length) {
    console.log(
      JSON.stringify(
        mismatch
          .slice(0, 3)
          .map((r) => ({
            id: r.id,
            metadata: Object.fromEntries(
              metadataFields.map((k) => [k, r.fields[k]]),
            ),
            expected: freshMatches.get(r.id),
            actual: confirmed.get(r.id),
          })),
      ),
    );
    throw new Error('Metadata semantic readback mismatch');
  }
  const views = await call('+view-list', [
    '--table-id',
    table,
    '--limit',
    '200',
  ]);
  if (views.has_more) throw new Error('Incomplete view listing');
  const named = views.views.filter((v) => v.name === '台账关联待确认');
  if (named.length > 1) throw new Error('Duplicate association views');
  let view = named[0];
  if (!view)
    view = await intent(
      'view-create',
      { name: '台账关联待确认', type: 'grid' },
      () =>
        call('+view-create', [
          '--table-id',
          table,
          '--json',
          JSON.stringify({ name: '台账关联待确认', type: 'grid' }),
        ]),
    );
  const viewId = view.id || view.view_id || view.view?.id || view.view?.view_id;
  if (!viewId) throw new Error('Missing created view id');
  const filter = {
    logic: 'or',
    conditions: [
      ['台账关联状态', '==', ['待确认']],
      ['台账关联状态', 'empty'],
    ],
  };
  await intent('view-filter', filter, () =>
    call('+view-set-filter', [
      '--table-id',
      table,
      '--view-id',
      viewId,
      '--json',
      JSON.stringify(filter),
    ]),
  );
  const visible = {
    visible_fields: [
      '维修单号',
      '台账关联状态',
      '台账关联说明',
      '所属数据中心/楼栋-使用',
      '所属数据中心/楼栋-使用-L',
      '设备编号',
      '设备编号-L',
      '设备名称',
      '设备名称-L',
      '故障发生时间-L',
      '故障发生现象描述-L',
      '流程',
    ],
  };
  await intent('view-visible-fields', visible, () =>
    call('+view-set-visible-fields', [
      '--table-id',
      table,
      '--view-id',
      viewId,
      '--json',
      JSON.stringify(visible),
    ]),
  );
  const actualView = await call('+view-get', [
    '--table-id',
    table,
    '--view-id',
    viewId,
  ]);
  const actualFilter = await call('+view-get-filter', [
    '--table-id',
    table,
    '--view-id',
    viewId,
  ]);
  const actualVisible = await call('+view-get-visible-fields', [
    '--table-id',
    table,
    '--view-id',
    viewId,
  ]);
  const viewRecords = await all(fields, viewId);
  const pendingIds = new Set(
    verified.filter((r) => !freshMatches.get(r.id).assetId).map((r) => r.id),
  );
  if (
    viewRecords.length !== pendingIds.size ||
    viewRecords.some((r) => !pendingIds.has(r.id))
  )
    throw new Error(
      'Pending view does not contain exactly the withheld repairs',
    );
  const internalId = fields.fields.find((f) => f.name === '关联台账记录ID').id;
  if (
    JSON.stringify(actualVisible).includes(internalId) ||
    JSON.stringify(actualVisible).includes('关联台账记录ID')
  )
    throw new Error('Internal binding field is visible');
  write('source-view-verification', {
    actualFilter,
    actualVisible,
    pendingRecordIds: viewRecords.map((r) => r.id),
    exactlyPending: true,
  });
  write('source-view-readback', actualView);
  write('source-schema-readback', fields);
  write('current-marked', { records: verified, sha256: sha(verified) });
  journal.completedAt = new Date().toISOString();
  for (const op of Object.values(journal.operations)) op.status = 'verified';
  write('source-mutation-ledger', journal);
  const proof = {
    status: 'RECORDS_AND_VIEW_VERIFIED',
    elapsedMs: Date.now() - started,
    rows: verified.length,
    linked: accepted.length,
    devices: new Set(accepted.map((r) => r.assetId)).size,
    pending: viewRecords.length,
    written,
    businessFieldsUnchanged: true,
    viewId,
    url: `https://vnet.feishu.cn/wiki/AnEBwJlvGiJfDdkOB32cUPuknzg?table=${table}&view=${viewId}`,
    snapshotHash: sha(verified),
  };
  write('source-mutation-proof', proof);
  console.log(JSON.stringify(proof));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
