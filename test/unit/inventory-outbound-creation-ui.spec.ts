import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const movementPageSource = readFileSync(
  join(root, 'client/src/pages/InventoryManagement/InventoryMovementPage.tsx'),
  'utf8',
);
const dialogSource = readFileSync(
  join(
    root,
    'client/src/pages/InventoryManagement/InventoryMovementCreateDialog.tsx',
  ),
  'utf8',
);

function section(start: string, end: string): string {
  const startIndex = movementPageSource.indexOf(start);
  const endIndex = movementPageSource.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return movementPageSource.slice(startIndex, endIndex);
}

describe('inventory outbound asynchronous creation UI contract', () => {
  it('collects multiple warehouse items with independent quantities before batch submission', () => {
    expect(dialogSource).toContain('outboundBatchLines');
    expect(dialogSource).toContain('aria-label="批量出库物品清单"');
    expect(dialogSource).toContain('line.quantity');
    expect(dialogSource).toContain('onOutboundBatchSubmit(submissions)');
    expect(movementPageSource).toContain('onOutboundBatchSubmit={submitOutboundBatch}');
  });
  it('uses the authenticated principal only as the durable local namespace and stale guard', () => {
    expect(movementPageSource).toContain(
      "import { useAccess } from '@/access/AccessProvider'",
    );
    expect(movementPageSource).toContain('principalFingerprint');
    expect(movementPageSource).toMatch(
      /getInventoryOutboundCreationTaskStorageKey\(\s*principalFingerprint\s*,?\s*\)/,
    );
    expect(movementPageSource).toContain(
      'readInventoryOutboundCreationTasks(principalFingerprint)',
    );
    expect(movementPageSource).toContain(
      'principalFingerprint: principalFingerprint',
    );
    expect(movementPageSource).toMatch(
      /const visibleOutboundCreationTasks\s*=\s*outboundPrincipalNamespaceRef\.current\s*===\s*outboundCreationTaskNamespace\s*\?\s*outboundCreationTasks\s*:\s*\[\]/s,
    );
    expect(movementPageSource).toMatch(
      /const visibleOutboundCreationTask\s*=\s*visibleOutboundCreationTasks\.find\(\(task\) => task\.taskId === null\) \|\| null/,
    );
    expect(movementPageSource).toContain('const movementNamespaceReady =');
    expect(movementPageSource).toMatch(
      /if \(previousNamespace !== namespace\) \{\s*setInboundState\(/s,
    );

    const submitSection = section(
      'const submitOutbound',
      'const openOutboundConfirmation',
    );
    expect(submitSection).toContain(
      'outboundPrincipalNamespaceRef.current !== namespace',
    );
    expect(submitSection).not.toMatch(
      /request\s*:\s*\{[^}]*principalFingerprint/s,
    );
  });

  it('routes outbound creation through the dedicated accept and task APIs', () => {
    expect(movementPageSource).toContain('submitInventoryOutbound');
    expect(movementPageSource).toContain('getInventoryOutboundTaskStatus');
    expect(movementPageSource).toContain(
      'createInventoryOutboundCreationRuntime({',
    );
    expect(movementPageSource).toContain(
      'readJournals: readInventoryOutboundCreationTasks',
    );
    expect(movementPageSource).toContain(
      'finalizeJournal: finalizeInventoryOutboundCreationTask',
    );
    expect(movementPageSource).toContain(
      'resolveJournal: resolveInventoryOutboundCreationTask',
    );

    const submitSection = section(
      'const submitOutbound',
      'const openOutboundConfirmation',
    );
    expect(submitSection).not.toContain('createInventoryMovement(');
    expect(submitSection).not.toContain('failMutation(');
    expect(submitSection).not.toContain('setCreateOpen(true)');
  });

  it('restores the persisted optimistic row and automatically resumes by task id or original request', () => {
    expect(movementPageSource).toContain('runtime.resumeAll(savedTasks)');
    expect(movementPageSource).toContain(
      'beginMutation(current, journalToOutboundSubmission(event.journal))',
    );
    expect(movementPageSource).toMatch(
      /runtime\.reconcileAuthoritativeMovement\(movement\)/,
    );
    expect(movementPageSource).toContain('runtime.checkNow()');
  });

  it('cleans up timers and stale responses on unmount, type change, and principal change', () => {
    expect(movementPageSource).toContain('runtime.stop()');
    expect(movementPageSource).toContain("window.addEventListener('focus'");
    expect(movementPageSource).toContain(
      "document.addEventListener('visibilitychange'",
    );
    expect(movementPageSource).toContain("window.removeEventListener('focus'");
    expect(movementPageSource).toContain(
      "document.removeEventListener('visibilitychange'",
    );
    expect(movementPageSource).toContain('principalRequestGenerationRef');
    expect(movementPageSource).toMatch(
      /const requestGeneration = principalRequestGenerationRef\.current;[\s\S]*principalRequestGenerationRef\.current !== requestGeneration/,
    );
    expect(movementPageSource).toContain('setCreateOpen(false)');
    expect(movementPageSource).toContain(
      'setManualOutboundRetryDraft(undefined)',
    );
    expect(movementPageSource).toContain('setSelectedOutbound(null)');
  });

  it('awaits journal persistence and resume before completing the UI handoff', () => {
    const submitSection = section(
      'const submitOutbound',
      'const openOutboundConfirmation',
    );
    expect(submitSection).toMatch(
      /async \(submission: InventoryOutboundSubmission\): Promise<boolean>/,
    );
    expect(submitSection).toContain('await runtime.start(input)');
    expect(submitSection).toContain(
      'await readInventoryOutboundCreationTasks(principalFingerprint)',
    );
    expect(movementPageSource).toContain(
      'await readInventoryOutboundCreationTasks(principalFingerprint)',
    );
    expect(movementPageSource).toContain('await runtime.resume(savedTask)');
    expect(dialogSource).toContain('async function submitOutbound()');
    expect(dialogSource).toContain('await handoffSubmissionOnce(');
  });

  it('keeps the outbound handoff animation inside the immediate-feedback budget', () => {
    expect(dialogSource).toContain(
      "animationDuration: type === 'outbound' ? '10ms' : undefined",
    );
  });

  it('keeps an unbound legacy create recovery fail-closed until explicit reconnect', () => {
    expect(movementPageSource).toContain('legacyOutboundCreateBlocked');
    expect(movementPageSource).toContain('检测到未绑定身份的旧版出库恢复记录');
    expect(movementPageSource).toContain('请联系管理员处理');
    expect(movementPageSource).toContain('重新连接旧版原任务');

    const setupSection = section(
      'const runtime = createInventoryOutboundCreationRuntime',
      'const checkNow =',
    );
    expect(setupSection).not.toContain(
      'migrateLegacyInventoryOutboundCreateRecovery(',
    );
    expect(setupSection).toContain(
      'if (hasUnboundLegacyOutboundCreateRecovery())',
    );

    const reconnectSection = section(
      'const reconnectLegacyOutboundCreation',
      'const submitOutbound',
    );
    expect(reconnectSection).toContain(
      'await migrateLegacyInventoryOutboundCreateRecovery(',
    );
    expect(reconnectSection).toContain(
      'clientMutationId: legacyRecovery.clientMutationId',
    );
    expect(reconnectSection).toContain('await runtime.resume(savedTask)');
    expect(reconnectSection).toContain('if (!migrated)');
    expect(reconnectSection).toContain('setLegacyOutboundCreateBlocked(true)');

    const submitSection = section(
      'const submitOutbound',
      'const openOutboundConfirmation',
    );
    expect(submitSection).toContain('legacyOutboundCreateBlocked');
  });

  it('keeps an invalid or unavailable durable journal visible and fail-closed', () => {
    expect(movementPageSource).toContain(
      'inspectInventoryOutboundCreationTasks',
    );
    expect(movementPageSource).toContain('outboundCreationStorageBlocked');
    expect(movementPageSource).toContain('本地出库任务日志异常');
    const setupSection = section(
      'const runtime = createInventoryOutboundCreationRuntime',
      'const checkNow =',
    );
    expect(setupSection).toContain("taskInspection.kind === 'unavailable'");
    expect(setupSection).toContain('setOutboundCreationStorageBlocked(true)');

    const submitSection = section(
      'const submitOutbound',
      'const openOutboundConfirmation',
    );
    expect(submitSection).toContain('outboundCreationStorageBlocked');
    expect(submitSection).toContain('本次未发送出库请求');
  });

  it('turns a missing no-task journal into an authoritative page refresh only', () => {
    const eventSection = section(
      'const handleCoordinatorEvent',
      'const runtime = createInventoryOutboundCreationRuntime',
    );
    expect(eventSection).toContain(
      "event.type === 'authoritative-refresh-required'",
    );
    expect(eventSection).toContain('loadMovementsRef.current?.(true)');
  });

  it('blocks only before task acceptance and allows the next outbound after task id', () => {
    expect(movementPageSource).toContain(
      'visibleOutboundCreationTasks.find((task) => task.taskId === null)',
    );
    const openSection = section(
      'const openMovementCreateDialog',
      'const abandonManualInboundRetry',
    );
    expect(openSection).toContain('visibleOutboundCreationTask');
    expect(openSection).toContain('等待服务端受理后再办理下一笔');

    const createRequestEffect = section(
      'useEffect(() => {\n    if (!createRequested)',
      'useEffect(() => {\n    setBuilding',
    );
    expect(createRequestEffect).toContain('visibleOutboundCreationTask');
    const submitSection = section(
      'const submitOutbound',
      'const openOutboundConfirmation',
    );
    expect(submitSection).toContain('runtime.hasPendingAcceptance()');
    expect(movementPageSource).toContain(
      '任务均已取得服务端编号，可继续办理下一笔',
    );
  });

  it('shows a persistent status strip without an abandon-original-id action', () => {
    for (const text of [
      '同步中',
      '笔出库后台同步中',
      '出库数据待核对',
      '系统不会重复出库',
      '立即查询全部',
      '重新连接未受理任务',
    ]) {
      expect(movementPageSource).toContain(text);
    }

    expect(movementPageSource).not.toContain('出库编号冲突');

    expect(movementPageSource).not.toContain('已放弃原出库编号');
    expect(movementPageSource).not.toContain('放弃原出库编号并编辑');
    expect(movementPageSource).not.toContain(
      'onAbandonRetry={abandonOutboundRetry}',
    );
    expect(dialogSource).toContain('onAbandonRetry?: () => void;');
  });

  it('shows uncertain outbound tasks as recoverable warnings without a spinner', () => {
    const statusStrip = section(
      "{type === 'outbound' && primaryOutboundCreationTask ? (",
      '<Card className=',
    );
    expect(statusStrip).toContain(
      "primaryOutboundCreationTask.status === 'uncertain'",
    );
    expect(statusStrip).toContain('出库结果待核对');
    expect(statusStrip).toContain('可离开页面');

    const movementStatus = section(
      'function MovementStatus',
      'interface CanonicalInboundExpectation',
    );
    expect(movementStatus).toContain('pendingSyncUncertain');
    expect(movementStatus).toContain('结果待核对');
    const uncertainStatus = section('if (pendingSyncUncertain) {', 'return (');
    expect(uncertainStatus).not.toContain('animate-spin');
  });

  it('shows the approval lifecycle without exposing warehouse confirmation early', () => {
    expect(movementPageSource).toContain("'待路由'");
    expect(movementPageSource).toContain("'待审批'");
    expect(movementPageSource).toContain("'待库房确认'");
    expect(movementPageSource).toContain("'已驳回'");
    expect(movementPageSource).toContain("'已出库'");

    const movementStatus = section(
      'function MovementStatus',
      'interface CanonicalInboundExpectation',
    );
    expect(movementStatus).toContain('待审批 · 后台同步中');
    expect(movementStatus).toContain('approvalRejectionReason');

    const records = section(
      'function MovementRecords',
      'function MovementDeletionDialog',
    );
    expect(records).toContain("outboundItem?.status === '待库房确认'");
    expect(records).toContain('getOutboundOperationHint(');
    const operationHint = section(
      'function getOutboundOperationHint',
      'function createClientMutationId',
    );
    expect(operationHint).toContain("item.status === '待审批'");
    expect(operationHint).toContain('等待审批');
    expect(operationHint).toContain("item.status === '待路由'");
    expect(operationHint).toContain('等待分配审批人');
    expect(operationHint).toContain("item.status === '已驳回'");
    expect(records).not.toMatch(
      /outboundItem\?\.status === '待审批'[\s\S]{0,240}onOutboundAction/,
    );
  });

  it('shows storage conflicts as non-terminal status without reopening the draft', () => {
    const eventSection = section(
      'const handleCoordinatorEvent',
      'const runtime = createInventoryOutboundCreationRuntime',
    );
    const statusSection = section(
      "if (event.type === 'status')",
      "if (event.type === 'completed')",
    );
    expect(statusSection).toContain('setOutboundCreationTaskStatus(');
    expect(statusSection).not.toContain('failMutation(');
    expect(statusSection).not.toContain('setCreateOpen(true)');
    expect(eventSection).toContain('setOutboundCreationTaskStatus');
    expect(movementPageSource).toContain('outboundCreationStatusMessages');
  });

  it('restores a definitely rejected draft without its old mutation id', () => {
    expect(movementPageSource).toContain('clientMutationId: undefined');
    expect(movementPageSource).toContain(
      '出库请求确定未写入，已恢复可编辑草稿',
    );
  });

  it('queues a failed background draft instead of overwriting a newer open form', () => {
    expect(movementPageSource).toContain('createOpenRef.current');
    expect(movementPageSource).toContain('queuedOutboundFailedReceipts');
    expect(movementPageSource).toContain('queueOutboundFailedReceipt');
    expect(movementPageSource).toContain('恢复下一笔出库草稿');
    expect(movementPageSource).toContain('当前编辑内容不会被后台失败任务覆盖');
  });

  it('bootstraps an unconsumed failed terminal receipt after active cleanup without restoring completed receipts', () => {
    expect(movementPageSource).toContain(
      'readUnconsumedInventoryOutboundCreationFailedReceipt',
    );
    expect(movementPageSource).toContain(
      'getInventoryOutboundCreationFailedReceiptIdentity',
    );
    expect(movementPageSource).toContain(
      "failedRecovery.kind !== 'failed-recovery'",
    );
    expect(movementPageSource).toContain(
      'const recoveredDraft = receipt.recovery.draft',
    );
    expect(movementPageSource).toContain('clientMutationId: undefined');
    expect(movementPageSource).toContain('pendingFailedReceiptConsumptionRef');
    const submitSection = section(
      'const submitOutbound',
      'const openOutboundConfirmation',
    );
    expect(submitSection).toContain('recoveredFromFailedReceipt:');
    expect(submitSection).toContain(
      'getInventoryOutboundCreationFailedReceiptIdentity',
    );
    expect(movementPageSource).not.toContain(
      'markInventoryOutboundCreationFailedReceiptConsumed',
    );
    expect(movementPageSource).toMatch(
      /runtime\.resumeAll\(savedTasks\)[\s\S]*readUnconsumedInventoryOutboundCreationFailedReceipt/,
    );
    expect(movementPageSource).not.toMatch(
      /failedRecovery\.kind\s*===\s*['"]completed['"]/,
    );
  });
});
