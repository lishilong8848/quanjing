import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInventoryInboundLifecycle } from './inventory-inbound-real-lifecycle.mjs';

await import('../dist/server/runtime-env.js');

const { InventoryWorkflowGateway, escapeBaseFilterText } =
  await import('../dist/server/modules/inventory-management/inventory-workflow.gateway.js');
const { PurchaseWorkflowGateway } =
  await import('../dist/server/modules/purchase-inventory/purchase-workflow.gateway.js');
const { parseFeishuBitableLink, readEnv } =
  await import('../dist/server/common/config/external-services.config.js');
const { resolveBitableAppToken } =
  await import('../dist/server/common/feishu/bitable-direct-read.js');

const DEFAULT_STATE_PATH = resolve(
  process.cwd(),
  'output/playwright/inventory-inbound-real-state.json',
);
const RESULT_PATH = resolve(
  process.cwd(),
  'output/playwright/inventory-inbound-real-result.json',
);
const TABLE_NAMES = {
  catalog: '物品类别',
  inventory: '库存台账',
  inbound: '入库填写',
  submission: '采购提交',
  execution: '采购执行',
};
const TARGET_BUILDING = 'H楼';
const ORIGINAL_BUILDING = 'A楼';
const PRIMARY_CATEGORY = 'C物资类';
const SECONDARY_CATEGORY = '应急物资C1';
const SPECIFICATION = '/';
const BRAND = '/';
const UNIT = '双';
const LOCATION = 'H-2F-226储存间01-0F';
const QUANTITY = 2;

const command = process.argv[2] || 'status';
const statePath = resolve(optionValue('--state') || DEFAULT_STATE_PATH);
const httpService = { axiosRef: axios };
const inventoryGateway = new InventoryWorkflowGateway(httpService);
const purchaseGateway = new PurchaseWorkflowGateway(httpService);

let config;

try {
  await runInventoryInboundLifecycle({
    command,
    operation: executeCommand,
    hasState: async () => Boolean(await loadState(false)),
    cleanup,
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

async function executeCommand() {
  if (command === 'prepare') {
    await prepare();
  } else if (command === 'checkpoint') {
    await checkpoint(process.argv[3]);
  } else if (command === 'verify') {
    await verify();
  } else if (command === 'cleanup' || command === 'cleanup-only') {
    await cleanup();
  } else if (command === 'status') {
    print(await loadState());
  } else {
    throw new Error(
      '命令必须是 prepare、checkpoint、verify、cleanup 或 status',
    );
  }
}

async function prepare() {
  const existing = await loadState(false);
  if (existing) {
    throw new Error(`状态文件已存在，请先运行 cleanup：${statePath}`);
  }
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const marker = `CODEX-INBOUND-E2E-${suffix}`;
  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    marker,
    targetBuilding: TARGET_BUILDING,
    manualNew: {
      mutationId: randomUUID(),
      itemName: `一次性拖鞋（入库测试-${suffix}）`,
    },
    manualExisting: {
      mutationId: randomUUID(),
    },
    purchase: {
      mutationId: randomUUID(),
      itemName: `一次性拖鞋（采购测试-${suffix}）`,
      submissionRecordId: '',
      executionRecordId: '',
    },
    results: {},
  };
  await saveState(state);

  const resolved = await getConfig();
  await ensureInboundInfrastructure(resolved);
  const tenantToken = await purchaseGateway.getTenantAccessTokenAsApp();
  state.purchase.submissionRecordId =
    await purchaseGateway.createSubmissionRecord(
      {
        采购编码: marker,
        新增物品名称: state.purchase.itemName,
        规格型号: SPECIFICATION,
        品牌: BRAND,
        单位: UNIT,
      },
      tenantToken,
    );
  await saveState(state);
  state.purchase.executionRecordId =
    await purchaseGateway.createExecutionRecord(
      {
        采购编码: marker,
        申请楼栋: [ORIGINAL_BUILDING],
        一级分类: PRIMARY_CATEGORY,
        二级分类: SECONDARY_CATEGORY,
        物品名称: state.purchase.itemName,
        '物品规格型号、设备序列号': SPECIFICATION,
        物品品牌: BRAND,
        计数单位: UNIT,
        采购申请数量: QUANTITY,
        实际采购数量: QUANTITY,
        '到货签收确认（签收内容填写完成后点击）': true,
        采购流程: '到货已签收（待入库）',
        签收时间: Date.now(),
      },
      tenantToken,
    );
  await saveState(state);
  print({
    success: true,
    statePath,
    marker,
    targetBuilding: TARGET_BUILDING,
    manualNewMutationId: state.manualNew.mutationId,
    manualExistingMutationId: state.manualExisting.mutationId,
    purchaseMutationId: state.purchase.mutationId,
    manualItemName: state.manualNew.itemName,
    purchaseItemName: state.purchase.itemName,
    purchaseExecutionRecordId: state.purchase.executionRecordId,
  });
}

async function checkpoint(kind) {
  if (!['manual-new', 'manual-existing', 'purchase'].includes(kind)) {
    throw new Error(
      'checkpoint 类型必须是 manual-new、manual-existing 或 purchase',
    );
  }
  const state = await loadState();
  const result = await waitForSourceRecords(state, kind);
  state.results[kind] = {
    checkedAt: new Date().toISOString(),
    sku: result.sku,
    catalogRecordIds: result.catalog.map(recordId),
    inventoryRecordIds: result.inventory.map(recordId),
    inboundRecordIds: result.inbound.map(recordId),
  };
  await saveState(state);
  print({
    success: true,
    kind,
    sku: result.sku,
    counts: recordCounts(result),
  });
}

async function verify() {
  const state = await loadState();
  for (const kind of ['manual-new', 'manual-existing', 'purchase']) {
    const result = await waitForSourceRecords(state, kind);
    state.results[kind] = {
      checkedAt: new Date().toISOString(),
      sku: result.sku,
      catalogRecordIds: result.catalog.map(recordId),
      inventoryRecordIds: result.inventory.map(recordId),
      inboundRecordIds: result.inbound.map(recordId),
    };
  }
  const manualSku = state.results['manual-new'].sku;
  if (state.results['manual-existing'].sku !== manualSku) {
    throw new Error('已有物品入库 SKU 与手工新增 SKU 不一致');
  }
  await verifyPurchaseFixtureAndStatus(state);
  await saveState(state);
  print({
    success: true,
    marker: state.marker,
    manualSku,
    purchaseSku: state.results.purchase.sku,
    verifiedAt: new Date().toISOString(),
  });
}

async function cleanup() {
  const state = await loadState(false);
  if (!state) {
    print({ success: true, alreadyClean: true, statePath });
    return;
  }
  const resolved = await getConfig();
  const sources = sourceEntries(state);
  const sourceSnapshots = [];
  for (const [kind, source] of sources) {
    const snapshot = await querySourceRecords(resolved, source);
    validateCleanupSnapshot(state, kind, source, snapshot);
    sourceSnapshots.push([kind, source, snapshot]);
  }

  for (const [, , snapshot] of sourceSnapshots) {
    for (const record of snapshot.inbound) {
      await retry(() =>
        inventoryGateway.deleteRecord(
          resolved.warehouseAppToken,
          resolved.inboundTableId,
          recordId(record),
          TABLE_NAMES.inbound,
        ),
      );
    }
  }

  const purchaseRecords = await queryPurchaseFixture(resolved, state.marker);
  validatePurchaseRecordIds(state, purchaseRecords);
  if (purchaseRecords.submissions.length || purchaseRecords.executions.length) {
    await retry(() =>
      purchaseGateway.batchDeleteRecordsAsApp({
        submissionRecordIds: purchaseRecords.submissions.map(recordId),
        executionRecordIds: purchaseRecords.executions.map(recordId),
      }),
    );
  }

  for (const [, , snapshot] of sourceSnapshots) {
    for (const record of snapshot.inventory) {
      await retry(() =>
        inventoryGateway.deleteRecord(
          resolved.warehouseAppToken,
          resolved.inventoryTableId,
          recordId(record),
          TABLE_NAMES.inventory,
        ),
      );
    }
  }
  for (const [, , snapshot] of sourceSnapshots) {
    for (const record of snapshot.catalog) {
      await retry(() =>
        inventoryGateway.deleteRecord(
          resolved.warehouseAppToken,
          resolved.catalogTableId,
          recordId(record),
          TABLE_NAMES.catalog,
        ),
      );
    }
  }

  const residual = [];
  for (const [kind, source] of sources) {
    const snapshot = await querySourceRecords(resolved, source);
    const counts = recordCounts(snapshot);
    if (Object.values(counts).some((count) => count !== 0)) {
      residual.push({ kind, source, counts });
    }
  }
  const purchaseResidual = await queryPurchaseFixture(resolved, state.marker);
  if (
    residual.length ||
    purchaseResidual.submissions.length ||
    purchaseResidual.executions.length
  ) {
    throw new Error(
      `清理后仍有残留：${JSON.stringify({
        residual,
        purchase: {
          submissions: purchaseResidual.submissions.length,
          executions: purchaseResidual.executions.length,
        },
      })}`,
    );
  }

  await atomicWriteJson(RESULT_PATH, {
    success: true,
    marker: state.marker,
    cleanedAt: new Date().toISOString(),
    inventoryResidualCount: 0,
    purchaseResidualCount: 0,
  });
  await unlink(statePath);
  print({
    success: true,
    cleaned: true,
    statePath,
    resultPath: RESULT_PATH,
    inventoryResidualCount: 0,
    purchaseResidualCount: 0,
  });
}

async function waitForSourceRecords(state, kind) {
  const expected =
    kind === 'manual-existing'
      ? { catalog: 0, inventory: 0, inbound: 1 }
      : { catalog: 1, inventory: 1, inbound: 1 };
  const source = sourceFor(state, kind);
  const resolved = await getConfig();
  let latest;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    latest = await querySourceRecords(resolved, source);
    const counts = recordCounts(latest);
    if (
      counts.catalog === expected.catalog &&
      counts.inventory === expected.inventory &&
      counts.inbound === expected.inbound
    ) {
      return validateSourceSnapshot(state, kind, source, latest);
    }
    if (attempt < 3) await delay(750 * (attempt + 1));
  }
  throw new Error(
    `${kind} 持久化数量不正确：${JSON.stringify(recordCounts(latest))}`,
  );
}

async function querySourceRecords(resolved, source) {
  const [catalog, inventory, inbound] = await Promise.all([
    inventoryGateway.listRecords({
      appToken: resolved.warehouseAppToken,
      tableId: resolved.catalogTableId,
      tableName: TABLE_NAMES.catalog,
      filter: exactFilter('入库创建标识', source),
    }),
    inventoryGateway.listRecords({
      appToken: resolved.warehouseAppToken,
      tableId: resolved.inventoryTableId,
      tableName: TABLE_NAMES.inventory,
      filter: exactFilter('入库创建标识', source),
    }),
    inventoryGateway.listRecords({
      appToken: resolved.warehouseAppToken,
      tableId: resolved.inboundTableId,
      tableName: TABLE_NAMES.inbound,
      filter: exactFilter('入库来源', source),
    }),
  ]);
  return { catalog, inventory, inbound };
}

function validateSourceSnapshot(state, kind, source, snapshot) {
  const itemName =
    kind === 'manual-new'
      ? state.manualNew.itemName
      : kind === 'purchase'
        ? state.purchase.itemName
        : '';
  let sku =
    clean(state.results?.[kind]?.sku) ||
    clean(state.results?.['manual-new']?.sku);
  if (snapshot.catalog.length) {
    const record = snapshot.catalog[0];
    assertEqual(text(record.fields, ['入库创建标识']), source, '目录来源');
    assertEqual(building(record.fields), TARGET_BUILDING, '目录楼栋');
    assertEqual(text(record.fields, ['名称']), itemName, '目录名称');
    sku = text(record.fields, ['物品类别号', '物品类别号（单选）'])
      .trim()
      .toUpperCase();
  }
  if (!sku && snapshot.inbound.length) {
    sku = text(snapshot.inbound[0].fields, ['物品类别号']).trim().toUpperCase();
  }
  if (!sku && snapshot.inventory.length) {
    sku = text(snapshot.inventory[0].fields, ['物品类别号'])
      .trim()
      .toUpperCase();
  }
  if (!sku) throw new Error(`${kind} 未读取到 SKU`);

  for (const record of snapshot.inventory) {
    assertEqual(text(record.fields, ['入库创建标识']), source, '台账来源');
    assertEqual(building(record.fields), TARGET_BUILDING, '台账楼栋');
    assertEqual(
      text(record.fields, ['物品类别号']).toUpperCase(),
      sku,
      '台账 SKU',
    );
    assertEqual(
      text(record.fields, ['入库存放位置', '存放位置']),
      LOCATION,
      '台账存放位置',
    );
  }
  for (const record of snapshot.inbound) {
    assertEqual(text(record.fields, ['入库来源']), source, '入库来源');
    assertEqual(building(record.fields), TARGET_BUILDING, '入库楼栋');
    assertEqual(
      text(record.fields, ['物品类别号']).toUpperCase(),
      sku,
      '入库 SKU',
    );
    assertEqual(number(record.fields, ['入库数量']), QUANTITY, '入库数量');
  }
  return { ...snapshot, sku };
}

function validateCleanupSnapshot(state, kind, source, snapshot) {
  if (
    snapshot.catalog.length === 0 &&
    snapshot.inventory.length === 0 &&
    snapshot.inbound.length === 0
  ) {
    return;
  }
  validateSourceSnapshot(state, kind, source, snapshot);
}

async function verifyPurchaseFixtureAndStatus(state) {
  const resolved = await getConfig();
  const records = await queryPurchaseFixture(resolved, state.marker);
  validatePurchaseRecordIds(state, records);
  if (records.submissions.length !== 1 || records.executions.length !== 1) {
    throw new Error('采购测试夹具数量不正确');
  }
  const execution = records.executions[0];
  const statuses = [
    text(execution.fields, ['采购流程']),
    text(execution.fields, ['程序采购状态']),
  ];
  if (
    statuses[0] !== '采购完成（已入库）' ||
    (statuses[1] && statuses[1] !== '物品签收已入库')
  ) {
    throw new Error(`采购执行状态未完成：${statuses.join(' / ')}`);
  }
  assertEqual(
    number(execution.fields, ['实际采购数量']),
    QUANTITY,
    '实际采购数量',
  );
}

async function queryPurchaseFixture(resolved, marker) {
  const filter = exactFilter('采购编码', marker);
  const [submissions, executions] = await Promise.all([
    inventoryGateway.listRecords({
      appToken: resolved.purchaseAppToken,
      tableId: resolved.submissionTableId,
      tableName: TABLE_NAMES.submission,
      filter,
    }),
    inventoryGateway.listRecords({
      appToken: resolved.purchaseAppToken,
      tableId: resolved.executionTableId,
      tableName: TABLE_NAMES.execution,
      filter,
    }),
  ]);
  return { submissions, executions };
}

function validatePurchaseRecordIds(state, records) {
  for (const record of [...records.submissions, ...records.executions]) {
    assertEqual(text(record.fields, ['采购编码']), state.marker, '采购编码');
  }
  const submissionIds = records.submissions.map(recordId);
  const executionIds = records.executions.map(recordId);
  if (
    submissionIds.length > 1 ||
    (submissionIds.length === 1 &&
      submissionIds[0] !== state.purchase.submissionRecordId)
  ) {
    throw new Error('采购提交记录 ID 与状态文件不一致');
  }
  if (
    executionIds.length > 1 ||
    (executionIds.length === 1 &&
      executionIds[0] !== state.purchase.executionRecordId)
  ) {
    throw new Error('采购执行记录 ID 与状态文件不一致');
  }
}

async function ensureInboundInfrastructure(resolved) {
  await Promise.all([
    inventoryGateway.ensureTextField(
      resolved.warehouseAppToken,
      resolved.catalogTableId,
      '入库创建标识',
      TABLE_NAMES.catalog,
    ),
    inventoryGateway.ensureTextField(
      resolved.warehouseAppToken,
      resolved.inventoryTableId,
      '入库创建标识',
      TABLE_NAMES.inventory,
    ),
    inventoryGateway.ensureTextField(
      resolved.warehouseAppToken,
      resolved.inboundTableId,
      '入库来源',
      TABLE_NAMES.inbound,
    ),
    inventoryGateway.ensureTextField(
      resolved.warehouseAppToken,
      resolved.catalogTableId,
      '入库请求指纹',
      TABLE_NAMES.catalog,
    ),
    inventoryGateway.ensureTextField(
      resolved.warehouseAppToken,
      resolved.inventoryTableId,
      '入库请求指纹',
      TABLE_NAMES.inventory,
    ),
    inventoryGateway.ensureTextField(
      resolved.warehouseAppToken,
      resolved.inventoryTableId,
      '入库存放位置',
      TABLE_NAMES.inventory,
    ),
    inventoryGateway.ensureTextField(
      resolved.warehouseAppToken,
      resolved.inboundTableId,
      '入库请求指纹',
      TABLE_NAMES.inbound,
    ),
  ]);
}

async function getConfig() {
  if (config) return config;
  const warehouseSource = parseFeishuBitableLink(
    readEnv('FEISHU_WAREHOUSE_SOURCE_URL'),
  );
  const purchaseSource = parseFeishuBitableLink(
    readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL'),
  );
  const [warehouseAppToken, purchaseAppToken] = await Promise.all([
    resolveBitableAppToken(httpService, {
      appToken:
        readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || warehouseSource.appToken,
      wikiToken: warehouseSource.wikiToken,
      tableName: '南通运维全景驾驶舱-库房管理',
    }),
    resolveBitableAppToken(httpService, {
      appToken:
        readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') ||
        purchaseSource.appToken,
      wikiToken:
        readEnv('FEISHU_PURCHASE_INVENTORY_WIKI_TOKEN') ||
        purchaseSource.wikiToken,
      tableName: '采购与库房管理',
    }),
  ]);
  config = {
    warehouseAppToken,
    purchaseAppToken,
    catalogTableId: requiredEnv('FEISHU_WAREHOUSE_CATALOG_TABLE_ID'),
    inventoryTableId: requiredEnv('FEISHU_WAREHOUSE_INVENTORY_TABLE_ID'),
    inboundTableId: requiredEnv('FEISHU_WAREHOUSE_INBOUND_TABLE_ID'),
    submissionTableId: requiredEnv('FEISHU_PURCHASE_SUBMISSION_TABLE_ID'),
    executionTableId: requiredEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID'),
  };
  return config;
}

function sourceEntries(state) {
  return [
    ['manual-new', sourceFor(state, 'manual-new')],
    ['manual-existing', sourceFor(state, 'manual-existing')],
    state.purchase.executionRecordId
      ? ['purchase', sourceFor(state, 'purchase')]
      : null,
  ].filter(Boolean);
}

function sourceFor(state, kind) {
  if (kind === 'manual-new') {
    return `手工:${state.manualNew.mutationId}`;
  }
  if (kind === 'manual-existing') {
    return `手工:${state.manualExisting.mutationId}`;
  }
  return `采购:${state.purchase.executionRecordId}`;
}

function recordCounts(snapshot) {
  return {
    catalog: snapshot.catalog.length,
    inventory: snapshot.inventory.length,
    inbound: snapshot.inbound.length,
  };
}

function exactFilter(fieldName, value) {
  return `CurrentValue.[${fieldName}]="${escapeBaseFilterText(value)}"`;
}

function recordId(record) {
  const value = clean(record?.record_id || record?.id);
  if (!value) throw new Error('记录缺少 record_id');
  return value;
}

function building(fields) {
  const values = displayValues(fields?.楼栋);
  return values.find((value) => /^[A-H]楼$/.test(value)) || '';
}

function text(fields, names) {
  for (const name of names) {
    const values = displayValues(fields?.[name]);
    if (values.length) return values.join('、').trim();
  }
  return '';
}

function number(fields, names) {
  const value = text(fields, names);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function displayValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(displayValues);
  if (typeof value === 'string' || typeof value === 'number') {
    const result = String(value).trim();
    return result ? [result] : [];
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'name', 'value']) {
      const values = displayValues(value[key]);
      if (values.length) return values;
    }
  }
  return [];
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}不一致：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }
}

async function retry(operation) {
  const delays = [0, 250, 500];
  let lastError;
  for (const waitMs of delays) {
    if (waitMs) await delay(waitMs);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function loadState(required = true) {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    if (error?.code === 'ENOENT') {
      throw new Error(`状态文件不存在：${statePath}`);
    }
    throw error;
  }
}

async function saveState(state) {
  await atomicWriteJson(statePath, state);
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

function requiredEnv(name) {
  const value = readEnv(name);
  if (!value) throw new Error(`环境变量未配置：${name}`);
  return value;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
