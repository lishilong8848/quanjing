import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import axios from 'axios';

const apply = process.argv.includes('--apply');
const restoreIndex = process.argv.indexOf('--restore');
const restoreArgument = restoreIndex >= 0 ? process.argv[restoreIndex + 1] : '';
const apiBase = 'https://open.feishu.cn/open-apis';
const appToken = requiredEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN');
const submissionTableId = requiredEnv('FEISHU_PURCHASE_SUBMISSION_TABLE_ID');
const executionTableId = requiredEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID');
const auth = {
  appId: requiredEnv('FEISHU_APP_ID'),
  appSecret: requiredEnv('FEISHU_APP_SECRET'),
};
const httpService = { axiosRef: axios };

const {
  extractDateTimeIso,
  extractDisplayText,
  extractNumberValue,
  fetchBitableRecords,
  getRecordId,
} = await import(
  '../dist/server/common/feishu/bitable-direct-read.js'
);
const { planPurchaseTableReconciliation } = await import(
  '../dist/server/modules/purchase-inventory/purchase-table-reconciliation.js'
);

if (restoreIndex >= 0) {
  await restoreBackup(restoreArgument);
  process.exit(0);
}

const [submissionRows, executionRows] = await Promise.all([
  readTable(submissionTableId, '采购提交'),
  readTable(executionTableId, '采购进行'),
]);
const submissions = submissionRows.map(mapSubmissionRecord);
const executions = executionRows.map(mapExecutionRecord);
const plan = planPurchaseTableReconciliation(submissions, executions);
const submissionById = new Map(submissions.map((record) => [record.recordId, record]));

console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      sourceCounts: {
        submissions: submissions.length,
        executions: executions.length,
      },
      plannedUpdates: plan.updates.length,
      unresolved: plan.unresolvedSubmissionRecordIds.length,
      sampleUpdates: plan.updates.slice(0, 20).map((update) => ({
        requester: submissionById.get(update.submissionRecordId)?.requester,
        itemName: submissionById.get(update.submissionRecordId)?.itemName,
        previousCode: update.previousCode,
        code: update.code,
        previousBuilding: update.previousBuilding,
        building: update.building,
      })),
      sampleUnresolved: plan.unresolvedSubmissionRecordIds
        .slice(0, 50)
        .map((recordId) => {
          const record = submissionById.get(recordId);
          return {
            requester: record?.requester,
            itemName: record?.itemName,
            code: record?.code,
            building: record?.building,
            createdAt: record?.createdAt
              ? new Date(record.createdAt).toISOString()
              : null,
          };
        }),
    },
    null,
    2,
  ),
);

if (!apply) process.exit(0);
if (!plan.updates.length) {
  console.log('No purchase table updates are required.');
  process.exit(0);
}

const backupDir = resolve('data', 'purchase-reconciliation-backups');
await mkdir(backupDir, { recursive: true });
const backupPath = resolve(
  backupDir,
  `${new Date().toISOString().replaceAll(':', '-')}.json`,
);
await writeFile(
  backupPath,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      submissionTableId,
      executionTableId,
      updates: plan.updates,
      unresolvedSubmissionRecordIds: plan.unresolvedSubmissionRecordIds,
    },
    null,
    2,
  ),
  'utf8',
);

const tenantToken = await authenticate();
for (const chunk of chunks(plan.updates, 100)) {
  await feishuRequest(
    `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
      submissionTableId,
    )}/records/batch_update`,
    tenantToken,
    {
      method: 'POST',
      body: {
        records: chunk.map((update) => ({
          record_id: update.submissionRecordId,
          fields: {
            采购编码: update.code,
            '申请楼栋（多楼请选H楼，备注里填写详情）': update.building,
          },
        })),
      },
    },
  );
}

const verifiedRows = await readTable(submissionTableId, '采购提交复核');
const verifiedById = new Map(
  verifiedRows.map((record) => [getRecordId(record), record]),
);
const mismatches = plan.updates.filter((update) => {
  const fields = verifiedById.get(update.submissionRecordId)?.fields ?? {};
  return (
    text(fields['采购编码']) !== update.code ||
    text(fields['申请楼栋（多楼请选H楼，备注里填写详情）']) !==
      update.building
  );
});
if (mismatches.length) {
  throw new Error(
    `Purchase table reconciliation verification failed for ${mismatches.length} records.`,
  );
}

console.log(
  JSON.stringify(
    {
      updated: plan.updates.length,
      unresolved: plan.unresolvedSubmissionRecordIds.length,
      backupPath,
      verified: true,
    },
    null,
    2,
  ),
);

async function readTable(tableId, tableName) {
  return fetchBitableRecords(httpService, {
    appToken,
    tableId,
    tableName,
    auth,
    cacheTtlMs: 0,
    forceRefresh: true,
    strict: true,
  });
}

function mapSubmissionRecord(record) {
  const fields = record.fields ?? {};
  return {
    recordId: getRecordId(record),
    code: text(fields['采购编码']),
    building: text(fields['申请楼栋（多楼请选H楼，备注里填写详情）']),
    requester: firstText(fields, ['业务申请人', '需求人', '申请人']),
    itemName: firstText(fields, ['非新增物品名称', '新增物品名称', '物品名称']),
    quantity: numberValue(fields, ['采购数量', '采购申请数量']),
    createdAt: recordTimestamp(record),
    note: firstText(fields, [
      '需求简述（采购原因、目的等）',
      '需求简述',
      '需求备注（提交人)',
    ]),
    unit: firstText(fields, ['单位', '计数单位']),
  };
}

function mapExecutionRecord(record) {
  const fields = record.fields ?? {};
  return {
    recordId: getRecordId(record),
    code: text(fields['采购编码']),
    building: text(fields['申请楼栋']),
    requester: firstText(fields, ['需求人', '业务申请人', '申请人']),
    itemName: firstText(fields, ['物品名称', '非新增物品名称', '新增物品名称']),
    quantity: numberValue(fields, ['采购申请数量', '采购数量']),
    createdAt: recordTimestamp(record),
    note: firstText(fields, [
      '需求简述（采购原因、目的等）',
      '需求简述',
      '需求备注（提交人)',
    ]),
    unit: firstText(fields, ['计数单位', '单位']),
  };
}

function firstText(fields, names) {
  for (const name of names) {
    const value = text(fields[name]);
    if (value) return value;
  }
  return '';
}

function text(value) {
  return extractDisplayText(value).trim();
}

function numberValue(fields, names) {
  for (const name of names) {
    const value = extractNumberValue(fields[name]);
    if (value !== null) return value;
  }
  return null;
}

function recordTimestamp(record) {
  const fields = record.fields ?? {};
  for (const value of [fields['创建日期'], fields['记录创建时间']]) {
    const iso = extractDateTimeIso(value);
    const timestamp = iso ? Date.parse(iso) : Number.NaN;
    if (!Number.isNaN(timestamp) && timestamp > 0) return timestamp;
  }
  const value = Number(record.created_time ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

async function restoreBackup(argument) {
  if (!argument) throw new Error('--restore requires a backup path.');
  const workspaceRoot = resolve('.');
  const backupPath = resolve(argument);
  if (
    backupPath !== workspaceRoot &&
    !backupPath.startsWith(`${workspaceRoot}${sep}`)
  ) {
    throw new Error('Backup path must stay inside the workspace.');
  }
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  if (
    backup?.submissionTableId !== submissionTableId ||
    !Array.isArray(backup?.updates)
  ) {
    throw new Error('Backup does not match the configured submission table.');
  }
  const tenantToken = await authenticate();
  for (const chunk of chunks(backup.updates, 100)) {
    await feishuRequest(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
        submissionTableId,
      )}/records/batch_update`,
      tenantToken,
      {
        method: 'POST',
        body: {
          records: chunk.map((update) => ({
            record_id: update.submissionRecordId,
            fields: {
              采购编码: update.previousCode,
              '申请楼栋（多楼请选H楼，备注里填写详情）':
                update.previousBuilding,
            },
          })),
        },
      },
    );
  }
  const verifiedRows = await readTable(submissionTableId, '采购提交恢复复核');
  const verifiedById = new Map(
    verifiedRows.map((record) => [getRecordId(record), record]),
  );
  const mismatches = backup.updates.filter((update) => {
    const fields = verifiedById.get(update.submissionRecordId)?.fields ?? {};
    return (
      text(fields['采购编码']) !== update.previousCode ||
      text(fields['申请楼栋（多楼请选H楼，备注里填写详情）']) !==
        update.previousBuilding
    );
  });
  if (mismatches.length) {
    throw new Error(`Backup restore verification failed for ${mismatches.length} records.`);
  }
  console.log(
    JSON.stringify(
      { restored: backup.updates.length, backupPath, verified: true },
      null,
      2,
    ),
  );
}

async function authenticate() {
  const response = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: auth.appId, app_secret: auth.appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.code !== 0 || !payload?.tenant_access_token) {
    throw new Error('Feishu authentication failed.');
  }
  return payload.tenant_access_token;
}

async function feishuRequest(path, token, options) {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`Feishu rejected purchase reconciliation: ${payload?.msg || response.status}.`);
  }
  return payload;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
