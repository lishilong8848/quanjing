import axios from 'axios';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LEAVE_TABLE_ID = 'tblpCzmTT3EapaUY';
const LEAVE_TABLE_NAME = '【勿动】员工请休假';
const MARKER_PREFIX = 'CODEX-SELFTEST-LEAVE-WORKFLOW';
const HOUR_MS = 60 * 60 * 1_000;
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/u;

export async function runLeaveWorkflowRealSelfTest(dependencies) {
  const identity = createIdentity();
  let recordId = '';
  let operationError = null;
  let cleanupError = null;
  let result = null;

  try {
    const candidate = await dependencies.selectCandidate();
    recordId = requireRecordId(
      await dependencies.createRecord({ identity, candidate }),
    );
    await dependencies.acceptApplication({ identity, candidate, recordId });
    const routed = await dependencies.runPendingTasks();
    if (routed.failed !== 0) {
      const failedApplication = await dependencies.getApplication(recordId);
      throw new Error(
        `routing task failure: expected 0, received ${routed.failed}; ${String(failedApplication?.lastError || 'unknown').slice(0, 300)}`,
      );
    }

    const application = await dependencies.getApplication(recordId);
    const stage = application?.currentStage;
    const firstApprover = stage?.approverOpenIds?.[0];
    const card = application?.stageCards?.find(
      (item) => item.recipientOpenId === firstApprover,
    );
    if (!firstApprover || !card?.messageId) {
      throw new Error('No safely routable approval card was generated.');
    }
    await dependencies.acceptApproval({
      eventId: `evt_leave_selftest_${identity.suffix}`,
      recordId,
      stageKey: stage.key,
      stageVersion: stage.version,
      actorOpenId: firstApprover,
      messageId: card.messageId,
    });
    const applied = await dependencies.runPendingTasks();
    if (applied.failed !== 0) {
      const failedApplication = await dependencies.getApplication(recordId);
      throw new Error(
        `approval task failure: expected 0, received ${applied.failed}; ${String(failedApplication?.lastError || 'unknown').slice(0, 300)}`,
      );
    }

    const record = await dependencies.readRecord(recordId);
    assertTerminalRecord(record, identity);
    result = {
      recordCreated: true,
      routedProcessed: routed.processed,
      appliedProcessed: applied.processed,
      cardSendCount: dependencies.cards.sent.length,
      cardPatchCount: dependencies.cards.patched.length,
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      if (recordId) await dependencies.deleteRecordSafely(recordId, identity);
      const residual = await dependencies.findByRequestId(identity.requestId);
      if (residual.length !== 0) {
        throw new Error(`Self-test cleanup left ${residual.length} record(s).`);
      }
    } catch (error) {
      cleanupError = error;
    }
    await dependencies.cleanupLedger();
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'Leave workflow self-test and cleanup failed.',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return {
    ok: true,
    mode: 'apply-real-bitable-fake-card',
    recordDeleted: true,
    residualCount: 0,
    cards: 'in-memory-only',
    ...result,
  };
}

export function createLeaveWorkflowSelfTestIdentity(
  now = new Date(),
  uuid = randomUUID(),
) {
  const timestamp = now.getTime();
  const suffix = String(uuid).replace(/-/gu, '').slice(0, 12).toLowerCase();
  const requestId = `leave-workflow-selftest-${uuid}`;
  const marker = `${MARKER_PREFIX}-${timestamp}-${suffix}`;
  const fingerprint = createHash('sha256')
    .update('leave-workflow-real-self-test-v1\0')
    .update(requestId)
    .update('\0')
    .update(marker)
    .digest('hex');
  return { requestId, marker, fingerprint, suffix };
}

function createIdentity() {
  return createLeaveWorkflowSelfTestIdentity();
}

async function createRealDependencies() {
  await import('../dist/server/runtime-env.js');
  const [
    configModule,
    directModule,
    activeModule,
    inventoryModule,
    workflowGatewayModule,
    workflowStoreModule,
    workflowServiceModule,
    workflowRulesModule,
  ] = await Promise.all([
    import('../dist/server/common/config/external-services.config.js'),
    import('../dist/server/common/feishu/bitable-direct-read.js'),
    import('../dist/server/modules/bitable-sync/active-personnel-directory.js'),
    import('../dist/server/modules/inventory-management/inventory-workflow.gateway.js'),
    import('../dist/server/modules/leave-workflow/leave-workflow.gateway.js'),
    import('../dist/server/modules/leave-workflow/leave-workflow.store.js'),
    import('../dist/server/modules/leave-workflow/leave-workflow.service.js'),
    import('../dist/server/modules/leave-workflow/leave-workflow.rules.js'),
  ]);
  const httpService = { axiosRef: axios };
  const appToken = await resolveLeaveAppToken(
    configModule,
    directModule,
    httpService,
  );
  const inventoryGateway = new inventoryModule.InventoryWorkflowGateway(
    httpService,
  );
  const realGateway = new workflowGatewayModule.LeaveWorkflowGateway(
    httpService,
  );
  const directory = await readActiveDirectory(
    configModule,
    directModule,
    activeModule,
    httpService,
  );
  const organizationRecords =
    await realGateway.fetchOrganizationRoutingRecords(true);
  const mergedOrganizationRecords = mergeOrganization(
    directory.personnel,
    organizationRecords,
  );
  const candidate = selectSafeCandidate(
    directory.personnel,
    mergedOrganizationRecords,
    workflowRulesModule.buildLeaveApprovalPlan,
  );
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'leave-workflow-real-self-test-'),
  );
  const store = new workflowStoreModule.LeaveWorkflowStore(
    join(temporaryDirectory, 'ledger.json'),
  );
  await store.onModuleInit();
  const cards = { sent: [], patched: [] };
  let sequence = 0;
  const safeGateway = {
    fetchOrganizationRoutingRecords: (...args) =>
      realGateway.fetchOrganizationRoutingRecords(...args),
    readLeaveRecord: (...args) => realGateway.readLeaveRecord(...args),
    updateLeaveRecord: (...args) => realGateway.updateLeaveRecord(...args),
    sendInteractiveCard: async (recipientOpenId, card, businessKey) => {
      sequence += 1;
      const messageId = `om_leave_selftest_${sequence}`;
      cards.sent.push({
        messageId,
        recipientDigest: digest(recipientOpenId),
        businessDigest: digest(businessKey),
        bytes: Buffer.byteLength(JSON.stringify(card), 'utf8'),
      });
      return messageId;
    },
    patchInteractiveCard: async (messageId, card) => {
      cards.patched.push({
        messageId,
        bytes: Buffer.byteLength(JSON.stringify(card), 'utf8'),
      });
    },
  };
  const personnelReader = {
    getCachedActivePersonnelDirectory: async () => directory,
  };

  const previousEnabled = process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED;
  process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED = 'true';
  const service = new workflowServiceModule.LeaveWorkflowService(
    store,
    safeGateway,
    personnelReader,
  );

  const restoreEnvironment = () => {
    process.env.LEAVE_WORKFLOW_PROGRAM_ENABLED = previousEnabled || '';
  };
  return {
    cards,
    selectCandidate: async () => candidate,
    createRecord: ({ identity, candidate: selected }) =>
      inventoryGateway.createRecord(
        appToken,
        LEAVE_TABLE_ID,
        {
          休假人员: [{ id: selected.openId }],
          休假开始时间: selected.startAtMs,
          休假结束时间: selected.endAtMs,
          休假工时数: 4,
          休假类型: '年假',
          请假原因: identity.marker,
          请求唯一ID: identity.requestId,
          请求指纹: identity.fingerprint,
          审批进度: '审批中',
          审批来源: '程序卡片',
          请假工作流状态: '待路由',
          请假审批策略版本: '2026-08-17-v1',
          请假工作流错误: '',
        },
        LEAVE_TABLE_NAME,
      ),
    acceptApplication: ({ identity, candidate: selected, recordId }) =>
      service.acceptApplications({
        clientMutationId: identity.requestId,
        recordIds: [recordId],
        leaveStaffName: selected.name,
        startAt: selected.startAt,
        endAt: selected.endAt,
        leaveType: '年假',
        leaveHours: 4,
        approvalDayCount: 1,
        reason: identity.marker,
      }),
    runPendingTasks: () => service.runPendingTasks(new Date(), 100),
    getApplication: (recordId) => store.getApplication(recordId),
    acceptApproval: (input) =>
      service.acceptApprovalAction({
        ...input,
        actorName: 'self-test-approver',
        action: 'approve',
      }),
    readRecord: (recordId) =>
      inventoryGateway.getRecord(
        appToken,
        LEAVE_TABLE_ID,
        recordId,
        LEAVE_TABLE_NAME,
      ),
    findByRequestId: (requestId) =>
      directModule.fetchBitableRecords(httpService, {
        appToken,
        tableId: LEAVE_TABLE_ID,
        tableName: LEAVE_TABLE_NAME,
        fieldNames: [
          '请求唯一ID',
          '请假原因',
          '请求指纹',
          '审批来源',
          '请假工作流状态',
          '审批进度',
        ],
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '请求唯一ID', operator: 'is', value: [requestId] },
          ],
        },
        cacheTtlMs: 0,
        forceRefresh: true,
        allowStale: false,
        strict: true,
      }),
    deleteRecordSafely: async (recordId, identity) => {
      const record = await inventoryGateway.getRecord(
        appToken,
        LEAVE_TABLE_ID,
        recordId,
        LEAVE_TABLE_NAME,
      );
      assertIdentity(record, identity);
      await inventoryGateway.deleteRecord(
        appToken,
        LEAVE_TABLE_ID,
        recordId,
        LEAVE_TABLE_NAME,
      );
    },
    cleanupLedger: async () => {
      restoreEnvironment();
      await rm(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

async function auditAndCleanupRealSelfTests() {
  await import('../dist/server/runtime-env.js');
  const [configModule, directModule, inventoryModule] = await Promise.all([
    import('../dist/server/common/config/external-services.config.js'),
    import('../dist/server/common/feishu/bitable-direct-read.js'),
    import('../dist/server/modules/inventory-management/inventory-workflow.gateway.js'),
  ]);
  const httpService = { axiosRef: axios };
  const appToken = await resolveLeaveAppToken(
    configModule,
    directModule,
    httpService,
  );
  const inventoryGateway = new inventoryModule.InventoryWorkflowGateway(
    httpService,
  );
  const records = await directModule.fetchBitableRecords(httpService, {
    appToken,
    tableId: LEAVE_TABLE_ID,
    tableName: LEAVE_TABLE_NAME,
    fieldNames: ['请求唯一ID', '请假原因', '请求指纹'],
    cacheTtlMs: 0,
    forceRefresh: true,
    allowStale: false,
    strict: true,
  });
  const candidates = records.filter((record) =>
    text(record?.fields?.请假原因).startsWith(MARKER_PREFIX),
  );
  for (const record of candidates) {
    const identity = identityFromPersistedRecord(record);
    assertIdentity(record, identity);
    await inventoryGateway.deleteRecord(
      appToken,
      LEAVE_TABLE_ID,
      record.record_id,
      LEAVE_TABLE_NAME,
    );
  }
  const remaining = await directModule.fetchBitableRecords(httpService, {
    appToken,
    tableId: LEAVE_TABLE_ID,
    tableName: LEAVE_TABLE_NAME,
    fieldNames: ['请假原因'],
    cacheTtlMs: 0,
    forceRefresh: true,
    allowStale: false,
    strict: true,
  });
  const residualCount = remaining.filter((record) =>
    text(record?.fields?.请假原因).startsWith(MARKER_PREFIX),
  ).length;
  if (residualCount !== 0) {
    throw new Error(
      `Leave workflow self-test cleanup left ${residualCount} record(s).`,
    );
  }
  return {
    ok: true,
    mode: 'audit-cleanup-real-self-test-records',
    deletedCount: candidates.length,
    residualCount,
  };
}

async function resolveLeaveAppToken(configModule, directModule, httpService) {
  const sourceUrl =
    configModule.readEnv('FEISHU_LEAVE_REQUEST_SOURCE_URL', [
      'FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL',
    ]) ||
    'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblpCzmTT3EapaUY&view=vewHyBE14E';
  const parsed = configModule.parseFeishuBitableLink(sourceUrl);
  const appToken = await directModule.resolveBitableAppToken(httpService, {
    appToken:
      configModule.readEnv('FEISHU_LEAVE_REQUEST_APP_TOKEN', [
        'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
        'FEISHU_MAIN_APP_TOKEN',
        'FEISHU_BITABLE_APP_TOKEN',
      ]) || parsed.appToken,
    wikiToken:
      configModule.readEnv('FEISHU_LEAVE_REQUEST_WIKI_TOKEN', [
        'FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN',
      ]) || parsed.wikiToken,
    tableName: LEAVE_TABLE_NAME,
  });
  process.env.FEISHU_LEAVE_REQUEST_APP_TOKEN = appToken;
  return appToken;
}

async function readActiveDirectory(
  configModule,
  directModule,
  activeModule,
  httpService,
) {
  const appToken = configModule.readEnv('FEISHU_ORG_APP_TOKEN', [
    'FEISHU_ORGANIZATION_APP_TOKEN',
  ]);
  const tableId =
    configModule.readEnv('FEISHU_ORG_TABLE_ID', [
      'FEISHU_ORGANIZATION_TABLE_ID',
    ]) || activeModule.DEFAULT_ACTIVE_PERSONNEL_TABLE_ID;
  const viewId =
    configModule.readEnv('FEISHU_ORG_VIEW_ID', [
      'FEISHU_ORGANIZATION_VIEW_ID',
    ]) || activeModule.DEFAULT_ACTIVE_PERSONNEL_VIEW_ID;
  const snapshot = await directModule.readLatestPersistedBitableRecordSnapshot({
    appToken: appToken || undefined,
    tableId,
    viewId,
    tableName: '在职人员',
  });
  if (!snapshot)
    throw new Error('Active personnel local snapshot is unavailable.');
  return activeModule.buildActivePersonnelDirectory(snapshot);
}

function selectSafeCandidate(
  personnel,
  organizationRecords,
  buildApprovalPlan,
) {
  for (const person of personnel) {
    try {
      const applicant = {
        name: person.name,
        openId: person.openId,
        position: person.position,
        buildings: person.buildings.map((building) =>
          normalizeBuilding(building),
        ),
      };
      const plan = buildApprovalPlan({
        applicant,
        organizationRecords,
        approvalDayCount: 1,
        managerEscalationApprovers: [],
      });
      if (plan.approvalClass !== 'ordinary' || plan.stages.length !== 1)
        continue;
      const start = nextShanghaiTestStart();
      return {
        name: applicant.name,
        openId: applicant.openId,
        startAt: formatShanghaiIso(start),
        endAt: formatShanghaiIso(new Date(start.getTime() + 4 * HOUR_MS)),
        startAtMs: start.getTime(),
        endAtMs: start.getTime() + 4 * HOUR_MS,
      };
    } catch {
      // Only a uniquely routed ordinary person is safe for this self-test.
    }
  }
  throw new Error('No safely routable ordinary leave applicant was found.');
}

function mergeOrganization(personnel, organizationRecords) {
  const merged = new Map(
    organizationRecords.map((item) => [item.openId, item]),
  );
  for (const person of personnel) {
    const current = merged.get(person.openId);
    if (current) continue;
    merged.set(person.openId, {
      name: person.name,
      openId: person.openId,
      position: person.position,
      buildings: person.buildings.map((building) =>
        normalizeBuilding(building),
      ),
      supervisorNames: [],
    });
  }
  return [...merged.values()];
}

function assertTerminalRecord(record, identity) {
  assertIdentity(record, identity);
  const fields = record?.fields || {};
  if (
    text(fields.审批来源) !== '程序卡片' ||
    text(fields.请假工作流状态) !== '已审批'
  ) {
    throw new Error(
      'Real Bitable terminal fields did not pass semantic verification.',
    );
  }
}

function assertIdentity(record, identity) {
  const fields = record?.fields || {};
  if (
    text(fields.请求唯一ID) !== identity.requestId ||
    text(fields.请假原因) !== identity.marker ||
    text(fields.请求指纹) !== identity.fingerprint
  ) {
    throw new Error('Self-test record identity mismatch; refusing deletion.');
  }
}

function identityFromPersistedRecord(record) {
  const fields = record?.fields || {};
  const requestId = text(fields.请求唯一ID);
  const marker = text(fields.请假原因);
  const fingerprint = text(fields.请求指纹);
  if (
    !requestId.startsWith('leave-workflow-selftest-') ||
    !marker.startsWith(MARKER_PREFIX) ||
    fingerprint !== selfTestFingerprint(requestId, marker)
  ) {
    throw new Error('Self-test audit identity mismatch; refusing deletion.');
  }
  return { requestId, marker, fingerprint };
}

function selfTestFingerprint(requestId, marker) {
  return createHash('sha256')
    .update('leave-workflow-real-self-test-v1\0')
    .update(requestId)
    .update('\0')
    .update(marker)
    .digest('hex');
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).join(' ').trim();
  if (value && typeof value === 'object')
    return String(value.text || value.name || value.value || '').trim();
  return String(value || '').trim();
}

function nextShanghaiTestStart() {
  const value = new Date(Date.now() + 14 * 24 * HOUR_MS);
  value.setUTCMinutes(0, 0, 0);
  return value;
}

function formatShanghaiIso(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00+08:00`;
}

function normalizeBuilding(value) {
  const clean = String(value || '').trim();
  return clean === '110'
    ? '110站'
    : clean.endsWith('楼') || clean.endsWith('站')
      ? clean
      : `${clean}楼`;
}

function requireRecordId(value) {
  const recordId =
    typeof value === 'string'
      ? value
      : value?.record_id || value?.recordId || value?.data?.record_id;
  if (!RECORD_ID_PATTERN.test(String(recordId || '')))
    throw new Error('Real Bitable create did not return a valid record id.');
  return String(recordId);
}

function digest(value) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 12);
}

function printSafe(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 1 ||
    !['--dry-run', '--apply-real', '--audit-cleanup'].includes(args[0])
  ) {
    throw new Error(
      'Only --dry-run, --apply-real, or --audit-cleanup is supported.',
    );
  }
  if (args[0] === '--dry-run') {
    printSafe({
      ok: true,
      mode: 'dry-run',
      writeEnabled: false,
      cards: 'in-memory-only',
      plannedScenario: {
        actualShiftGroups: ['day', 'night'],
        initialAssignments: 2,
        partialNightAdjustment: true,
        verifyFirstClickAcceptance: true,
        verifyReplayIdempotency: true,
        cleanupByExactIds: true,
      },
    });
    return;
  }
  if (args[0] === '--audit-cleanup') {
    printSafe(await auditAndCleanupRealSelfTests());
    return;
  }
  const dependencies = await createRealDependencies();
  printSafe(await runLeaveWorkflowRealSelfTest(dependencies));
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isMain) {
  try {
    await main();
  } catch (error) {
    printSafe({
      ok: false,
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        300,
      ),
    });
    process.exitCode = 1;
  }
}
