import axios from 'axios';
import { createHash, randomUUID as createRandomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OVERTIME_TABLE_ID = 'tblpCzmTT3EapaUY';
const DEFAULT_OVERTIME_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblpCzmTT3EapaUY&view=vewHyBE14E';
const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const MARKER_PATTERN = /^CODEX-SELFTEST-OVERTIME-WORKFLOW-\d{13}-[0-9a-f]{8}$/u;
const UNIQUE_ID_PATTERN =
  /^overtime-workflow-selftest-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MANAGER_POSITIONS = new Set(['设施运维经理', '设施运维副经理']);
const OVERTIME_MATRIX_TARGETS = Object.freeze([
  { scenario: 'building_a', routeKind: 'building_supervisor', building: 'A楼' },
  { scenario: 'building_b', routeKind: 'building_supervisor', building: 'B楼' },
  { scenario: 'building_c', routeKind: 'building_supervisor', building: 'C楼' },
  { scenario: 'building_d', routeKind: 'building_supervisor', building: 'D楼' },
  { scenario: 'building_e', routeKind: 'building_supervisor', building: 'E楼' },
  { scenario: 'h_duty', routeKind: 'h_duty_supervisor', building: 'H楼' },
  {
    scenario: 'station_110',
    routeKind: 'station_110_electrical_supervisor',
    building: '110站',
  },
  { scenario: 'manager_group', routeKind: 'manager_group', building: '' },
]);
const BASE_IDENTITY_FIELDS = ['请求唯一ID', '加班原因', '请求指纹'];
const BASE_VERIFICATION_FIELDS = [
  ...BASE_IDENTITY_FIELDS,
  '加班工作流状态',
  '加班审批',
  '加班流程进展',
  '审批进度',
  '加班审批人',
  '加班审批时间',
  '加班经理知会时间',
  '实际加班开始时间',
  '实际加班结束时间',
  '实际加班时长',
  '确认加班工时',
  '加班工时处置',
  '加班确认',
  '加班确认人',
  '加班确认时间',
  '加班工作流错误',
];
const VERIFIED_OVERTIME_NUMBER_FIELDS = Object.freeze([
  '实际加班时长',
  '确认加班工时',
]);
const WORKFLOW_SELF_TEST_PHASE_CODES = new Map([
  ['candidate-route', 'CANDIDATE_ROUTE_FAILED'],
  ['base-create', 'BASE_CREATE_FAILED'],
  ['workflow-accept', 'WORKFLOW_ACCEPT_FAILED'],
  ['route-delivery', 'APPROVAL_ROUTE_FAILED'],
  ['approval-accept', 'APPROVAL_ACCEPT_FAILED'],
  ['approval-apply', 'APPROVAL_APPLY_FAILED'],
  ['confirmation-reminder', 'CONFIRMATION_REMINDER_FAILED'],
  ['confirmation-delivery', 'CONFIRMATION_DELIVERY_FAILED'],
  ['confirmation-submit', 'CONFIRMATION_SUBMIT_FAILED'],
  ['confirmation-apply', 'CONFIRMATION_APPLY_FAILED'],
  ['base-verify', 'BASE_VERIFY_FAILED'],
  ['record-cleanup', 'CLEANUP_FAILED'],
  ['ledger-cleanup', 'LEDGER_CLEANUP_FAILED'],
  ['audit', 'AUDIT_FAILED'],
]);
const workflowSelfTestErrorPhases = new WeakMap();

export class UnsafeOvertimeWorkflowCleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeOvertimeWorkflowCleanupError';
  }
}

export class OvertimeWorkflowSelfTestAssertionError extends Error {
  constructor({
    assertionCode,
    field,
    expectedType,
    expectedValueCategory,
    actualType,
    actualValue,
  }) {
    super(`BASE_ASSERTION:${assertionCode}:${field}`);
    this.name = 'OvertimeWorkflowSelfTestAssertionError';
    this.diagnostic = Object.freeze({
      assertionCode,
      field,
      expectedType,
      expectedValueCategory,
      actualType,
      actualValue,
    });
  }
}

export function createWorkflowSelfTestIdentity(nowInput, uuidInput) {
  const now = resolveDate(nowInput, '自测时间无效');
  const uuid = clean(uuidInput).toLowerCase();
  if (!UUID_PATTERN.test(uuid)) {
    throw new TypeError('自测 UUID 格式无效');
  }
  const marker = `CODEX-SELFTEST-OVERTIME-WORKFLOW-${now.getTime()}-${uuid.slice(0, 8)}`;
  const requestUniqueId = `overtime-workflow-selftest-${uuid}`;
  const fingerprint = createHash('sha256')
    .update('overtime-workflow-real-self-test-v1\0')
    .update(requestUniqueId)
    .update('\0')
    .update(marker)
    .digest('hex');
  return validateIdentity({ requestUniqueId, marker, fingerprint });
}

export function selectOvertimeWorkflowMatrixCandidates(input = {}) {
  const personnel = Array.isArray(input.personnel) ? input.personnel : [];
  const organizationRecords = Array.isArray(input.organizationRecords)
    ? input.organizationRecords
    : [];
  if (typeof input.resolveRoute !== 'function') {
    throw new TypeError('多楼栋自测缺少审批路由解析器');
  }
  const mergedRecords = [
    ...organizationRecords,
    ...personnel.map((person) => ({
      name: clean(person?.name),
      openId: clean(person?.openId),
      position: clean(person?.position),
      buildings: Array.isArray(person?.buildings) ? person.buildings : [],
      supervisorNames: [],
    })),
  ];
  const configuredManagerRecipients = Array.isArray(input.managerRecipients)
    ? input.managerRecipients
    : [];
  const managerRecipients = normalizeExpectedOpenIds(
    configuredManagerRecipients.length > 0
      ? configuredManagerRecipients
      : mergedRecords.filter((entry) =>
          MANAGER_POSITIONS.has(clean(entry?.position).replace(/\s+/gu, '')),
        ),
    '机房经理',
  );
  const usedPeople = new Set();
  const candidates = [];
  const skipped = [];

  for (const target of OVERTIME_MATRIX_TARGETS) {
    let selected = null;
    for (const person of personnel) {
      const openId = clean(person?.openId);
      const buildings = Array.isArray(person?.buildings)
        ? person.buildings.map(normalizeMatrixBuilding).filter(Boolean)
        : [];
      if (!OPEN_ID_PATTERN.test(openId) || usedPeople.has(openId)) continue;
      if (target.building && !buildings.includes(target.building)) continue;
      try {
        const route = input.resolveRoute({
          applicant: {
            name: clean(person?.name),
            openId,
            position: clean(person?.position),
            buildings,
          },
          organizationRecords: mergedRecords,
        });
        if (
          clean(route?.kind) !== target.routeKind ||
          !Array.isArray(route?.approvers) ||
          route.approvers.length === 0
        ) {
          continue;
        }
        const expectedApproverOpenIds = normalizeExpectedOpenIds(
          route.approvers,
          '审批人',
        );
        const expectedManagerOpenIds = managerRecipients.filter(
          (managerOpenId) => managerOpenId !== openId,
        );
        if (expectedManagerOpenIds.length === 0) continue;
        const building = target.building || buildings[0];
        if (!building) continue;
        selected = {
          scenario: target.scenario,
          routeKind: target.routeKind,
          staffName: clean(person?.name),
          staffOpenId: openId,
          building,
          position: clean(person?.position),
          expectedApproverOpenIds,
          expectedManagerOpenIds,
        };
        break;
      } catch {
        // A real candidate is eligible only when its route resolves uniquely.
      }
    }
    if (selected) {
      candidates.push(selected);
      usedPeople.add(selected.staffOpenId);
    } else {
      skipped.push({
        scenario: target.scenario,
        reason: 'NO_MATCHING_ROUTE',
      });
    }
  }
  return { candidates, skipped };
}

export async function runOvertimeWorkflowRealMatrixSelfTest(
  options = {},
  matrixDependencies = {},
) {
  const candidates = Array.isArray(matrixDependencies.candidates)
    ? matrixDependencies.candidates.map(validateMatrixCandidate)
    : [];
  const skipped = sanitizeMatrixSkipped(matrixDependencies.skipped);
  if (
    typeof matrixDependencies.createScenarioDependencies !== 'function' ||
    typeof matrixDependencies.audit !== 'function'
  ) {
    throw new TypeError('多楼栋真实自测依赖不完整');
  }
  assertMatrixCoverage(candidates);
  const zeroHoursCandidate =
    candidates.find((candidate) => candidate.scenario === 'building_a') ||
    candidates[0];
  const executeScenario =
    typeof matrixDependencies.executeScenario === 'function'
      ? matrixDependencies.executeScenario
      : runOvertimeWorkflowRealSelfTest;
  const scenarioResults = [];
  let operationError = null;
  let auditError = null;
  let audit = null;

  try {
    for (const candidate of candidates) {
      const deps =
        await matrixDependencies.createScenarioDependencies(candidate);
      const confirmationActualHours =
        candidate.scenario === zeroHoursCandidate.scenario ? 0 : undefined;
      const result = await executeScenario(
        { ...options, confirmationActualHours },
        deps,
      );
      assertMatrixScenarioResult(
        candidate,
        result,
        confirmationActualHours === 0,
      );
      scenarioResults.push({
        scenario: candidate.scenario,
        route: candidate.routeKind,
        building: candidate.building,
        result: 'confirmed-cleaned',
        approverCount: finiteCount(result.approverCount),
        managerRecipientCount: finiteCount(result.managerRecipientCount),
        approvalCardCount: finiteCount(result.approvalCardCount),
        managerNoticeCardCount: finiteCount(result.managerNoticeCardCount),
        confirmationRecipientCount: finiteCount(
          result.confirmationRecipientCount,
        ),
        initialConfirmationCardCount: finiteCount(
          result.initialConfirmationCardCount,
        ),
        confirmationResultCardCount: finiteCount(
          result.confirmationResultCardCount,
        ),
        actualHours: Number(result.actualHours),
      });
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      audit = await matrixDependencies.audit();
      const residualCount = Number(audit?.candidateCount);
      if (!Number.isInteger(residualCount) || residualCount !== 0) {
        throw new UnsafeOvertimeWorkflowCleanupError(
          '多楼栋真实自测结束后仍存在自测残留记录',
        );
      }
    } catch (error) {
      auditError = error;
    }
  }

  if (operationError && auditError) {
    throw new AggregateError(
      [operationError, auditError],
      '多楼栋加班工作流自测失败，且残留审计未通过',
    );
  }
  if (operationError) throw operationError;
  if (auditError) throw auditError;

  return {
    ok: true,
    mode: 'apply-real-matrix',
    scenarioCount: scenarioResults.length,
    distinctBuildingCount: new Set(
      scenarioResults.map((entry) => entry.building),
    ).size,
    scenarios: scenarioResults,
    zeroHoursScenario: zeroHoursCandidate.scenario,
    skipped,
    residualCount: Number(audit.candidateCount),
    cards: 'in-memory-only',
  };
}

export async function runOvertimeWorkflowRealSelfTest(options = {}, deps) {
  assertDependencies(deps);
  const now = resolveDate(deps.now?.() ?? new Date(), '自测时间无效');
  const uuid = deps.randomUUID?.() ?? createRandomUUID();
  const identity = createWorkflowSelfTestIdentity(now, uuid);
  const plannedEnd = floorToHour(new Date(now.getTime() - HOUR_MS));
  const plannedStart = new Date(plannedEnd.getTime() - HOUR_MS);
  const range = {
    plannedStartAt: formatShanghaiIso(plannedStart),
    plannedEndAt: formatShanghaiIso(plannedEnd),
  };
  let recordId = '';
  let operationError = null;
  let recordCleanupError = null;
  let ledgerCleanupError = null;
  let cleanupResult = { deleted: false, residualCount: 0 };
  let result = null;

  try {
    const candidate = await runWorkflowSelfTestPhase(
      'candidate-route',
      async () =>
        validateCandidate(
          await deps.selectCandidate({ ...range, identity }),
          range,
        ),
    );
    recordId = await runWorkflowSelfTestPhase('base-create', async () =>
      requireRecordId(await deps.createBaseRecord({ identity, candidate })),
    );
    await runWorkflowSelfTestPhase('workflow-accept', () =>
      deps.acceptApplication({ identity, candidate, recordId }),
    );
    await runWorkflowSelfTestPhase('route-delivery', () =>
      deps.runPendingTasks(resolveExecutionNow(deps)),
    );

    let application = await runWorkflowSelfTestPhase(
      'route-delivery',
      async () =>
        validateApplication(
          await deps.getApplication(recordId),
          'approval_pending',
        ),
    );
    const approver = application.approvers[0];
    await runWorkflowSelfTestPhase('approval-accept', () =>
      deps.acceptApproval({
        eventId: `evt_${uuid.replaceAll('-', '')}`,
        recordId,
        approver,
        application,
      }),
    );
    await runWorkflowSelfTestPhase('approval-apply', () =>
      deps.runPendingTasks(resolveExecutionNow(deps)),
    );
    application = await runWorkflowSelfTestPhase('approval-apply', async () =>
      validateApplication(
        await deps.getApplication(recordId),
        'awaiting_confirmation',
      ),
    );
    if (application.actualApproverOpenId !== approver.openId) {
      await runWorkflowSelfTestPhase('approval-apply', () => {
        throw new Error('审批同意后实际审批人未正确落入本地账本');
      });
    }

    const reminderCount = await runWorkflowSelfTestPhase(
      'confirmation-reminder',
      async () =>
        Number(await deps.enqueueDueConfirmationReminders(recordId, now)),
    );
    if (!Number.isInteger(reminderCount) || reminderCount < 1) {
      await runWorkflowSelfTestPhase('confirmation-reminder', () => {
        throw new Error('到期加班确认提醒未成功入队');
      });
    }
    await runWorkflowSelfTestPhase('confirmation-delivery', () =>
      deps.runPendingTasks(resolveExecutionNow(deps)),
    );
    await runWorkflowSelfTestPhase('confirmation-delivery', async () =>
      validateApplication(
        await deps.getApplication(recordId),
        'awaiting_confirmation',
      ),
    );

    await runWorkflowSelfTestPhase('confirmation-submit', () =>
      deps.submitConfirmation({
        mutationId: `overtime-confirm-selftest-${uuid}`,
        recordId,
        approver,
        actualStartAt: range.plannedStartAt,
        actualHours:
          options.confirmationActualHours === 0 ? 0 : candidate.plannedHours,
        disposition:
          options.confirmationActualHours === 0 ? null : 'compensatory_leave',
      }),
    );
    await runWorkflowSelfTestPhase('confirmation-apply', () =>
      deps.runPendingTasks(resolveExecutionNow(deps)),
    );
    application = await runWorkflowSelfTestPhase(
      'confirmation-apply',
      async () =>
        validateApplication(await deps.getApplication(recordId), 'confirmed'),
    );
    const cardDeliveryCoverage = await runWorkflowSelfTestPhase(
      'confirmation-apply',
      () => assertWorkflowCardDeliveryCoverage(application),
    );

    await runWorkflowSelfTestPhase('base-verify', async () => {
      const persisted = await deps.readBaseRecord(recordId);
      assertWorkflowSelfTestIdentity(identity, persisted, recordId);
      const verificationRecord =
        typeof deps.normalizeBaseRecordForVerification === 'function'
          ? deps.normalizeBaseRecordForVerification(persisted)
          : persisted;
      assertConfirmedWorkflowFields(verificationRecord, {
        approverOpenId: approver.openId,
        actualHours:
          options.confirmationActualHours === 0 ? 0 : candidate.plannedHours,
        actualStartAt: range.plannedStartAt,
      });
    });
    const evidenceValue = deps.evidence?.();
    const evidence = isObject(evidenceValue) ? evidenceValue : {};
    const expectedCardSendCount = cardDeliveryCoverage.expectedCardSendCount;
    const fakeCardSendCount = finiteCount(evidence.fakeCardSendCount);
    if (typeof deps.evidence === 'function') {
      await runWorkflowSelfTestPhase('confirmation-apply', () => {
        assertWorkflowCardSendEvidence(cardDeliveryCoverage, evidence);
      });
    }
    result = {
      ok: true,
      recordRef: safeRef(recordId),
      requestRef: safeRef(identity.requestUniqueId),
      approverCount: application.approvers.length,
      managerRecipientCount: application.managerRecipients.length,
      approvalCardCount: cardDeliveryCoverage.approvalCardCount,
      managerNoticeCardCount: cardDeliveryCoverage.managerNoticeCardCount,
      confirmationRecipientCount:
        cardDeliveryCoverage.confirmationRecipientCount,
      initialConfirmationCardCount:
        cardDeliveryCoverage.initialConfirmationCardCount,
      confirmationResultCardCount:
        cardDeliveryCoverage.confirmationResultCardCount,
      expectedCardSendCount,
      reminderCount,
      fakeCardSendCount,
      fakeCardStageCounts: normalizeWorkflowCardStageCounts(
        evidence.fakeCardStageCounts,
      ),
      fakeCardPatchCount: finiteCount(evidence.fakeCardPatchCount),
      fakeCardPatchStageCounts: normalizeWorkflowCardPatchStageCounts(
        evidence.fakeCardPatchStageCounts,
      ),
      fakeCardPatchCoverageExact: evidence.fakeCardPatchCoverageExact === true,
      approverOpenIds: application.approvers.map((entry) => entry.openId),
      managerRecipientOpenIds: application.managerRecipients.map(
        (entry) => entry.openId,
      ),
      workflowState: 'confirmed',
      actualHours:
        options.confirmationActualHours === 0 ? 0 : candidate.plannedHours,
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      cleanupResult = await runWorkflowSelfTestPhase('record-cleanup', () =>
        cleanupWorkflowSelfTestRecord(identity, recordId, deps),
      );
    } catch (error) {
      recordCleanupError = error;
    }
    try {
      await runWorkflowSelfTestPhase('ledger-cleanup', () =>
        deps.cleanupLedger(),
      );
    } catch (error) {
      ledgerCleanupError = error;
    }
  }

  const errors = [
    operationError,
    recordCleanupError,
    ledgerCleanupError,
  ].filter(Boolean);
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      '加班工作流真实自测失败，且至少一个清理步骤失败',
    );
  }
  if (errors.length === 1) throw errors[0];
  return {
    ...result,
    cleaned: cleanupResult.deleted === true,
    residualCount: cleanupResult.residualCount,
  };
}

export async function cleanupWorkflowSelfTestRecord(
  identityInput,
  recordIdInput,
  deps,
) {
  const identity = validateIdentity(identityInput);
  const queried = await deps.queryBaseByUniqueId(identity.requestUniqueId);
  if (!Array.isArray(queried)) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      '按请求唯一ID查询的响应格式无效，拒绝删除',
    );
  }
  if (queried.length === 0) {
    return { deleted: false, residualCount: 0, alreadyClean: true };
  }
  if (queried.length !== 1) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      `请求唯一ID命中 ${queried.length} 条记录，拒绝批量删除`,
    );
  }
  const queriedId = getRecordId(queried[0]);
  const suppliedId = clean(recordIdInput);
  const recordId = suppliedId || queriedId;
  if (!RECORD_ID_PATTERN.test(recordId) || queriedId !== recordId) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      '查询记录与已知 recordId 不一致，拒绝删除',
    );
  }
  assertWorkflowSelfTestIdentity(identity, queried[0], recordId);
  const exact = await deps.readBaseRecord(recordId);
  assertWorkflowSelfTestIdentity(identity, exact, recordId);
  await deps.deleteBaseRecord(recordId);
  const residual = await deps.queryBaseByUniqueId(identity.requestUniqueId);
  if (!Array.isArray(residual) || residual.length !== 0) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      `精确删除后仍残留 ${Array.isArray(residual) ? residual.length : '未知'} 条记录`,
    );
  }
  return { deleted: true, residualCount: 0, recordRef: safeRef(recordId) };
}

export async function auditWorkflowSelfTestRecords(deps) {
  if (
    !isObject(deps) ||
    typeof deps.listWorkflowSelfTestRecords !== 'function'
  ) {
    throw new TypeError('加班工作流残留审计依赖不完整');
  }
  return runWorkflowSelfTestPhase('audit', async () => {
    const records = await deps.listWorkflowSelfTestRecords();
    if (!Array.isArray(records)) {
      throw new Error('加班工作流残留审计响应格式无效');
    }
    const candidates = records
      .map(inspectWorkflowSelfTestRecord)
      .filter((entry) => entry.isCandidate);
    return {
      ok: true,
      mode: 'audit-only',
      candidateCount: candidates.length,
      validIdentityCount: candidates.filter((entry) => entry.identityValid)
        .length,
      invalidIdentityCount: candidates.filter((entry) => !entry.identityValid)
        .length,
      records: candidates.map((entry) => ({
        recordRef: entry.recordRef,
        identityValid: entry.identityValid,
      })),
    };
  });
}

export async function cleanupResidualWorkflowSelfTestRecords(deps) {
  if (
    !isObject(deps) ||
    typeof deps.listWorkflowSelfTestRecords !== 'function' ||
    typeof deps.queryBaseByUniqueId !== 'function' ||
    typeof deps.readBaseRecord !== 'function' ||
    typeof deps.deleteBaseRecord !== 'function'
  ) {
    throw new TypeError('加班工作流残留清理依赖不完整');
  }
  const records = await deps.listWorkflowSelfTestRecords();
  if (!Array.isArray(records)) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      '加班工作流残留扫描响应格式无效，拒绝删除',
    );
  }
  const candidates = records
    .map(inspectWorkflowSelfTestRecord)
    .filter((entry) => entry.isCandidate);
  const invalid = candidates.filter((entry) => !entry.identityValid);
  if (invalid.length > 0) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      `发现 ${invalid.length} 条身份不完整的自测标记记录，拒绝自动删除`,
    );
  }
  let deletedCount = 0;
  for (const candidate of candidates) {
    const cleanup = await cleanupWorkflowSelfTestRecord(
      candidate.identity,
      candidate.recordId,
      deps,
    );
    if (cleanup.deleted) deletedCount += 1;
  }
  const audit = await auditWorkflowSelfTestRecords(deps);
  if (audit.candidateCount !== 0) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      `清理后仍残留 ${audit.candidateCount} 条自测标记记录`,
    );
  }
  return {
    ok: true,
    mode: 'cleanup-only',
    deletedCount,
    residualCount: 0,
  };
}

export function assertWorkflowSelfTestIdentity(
  identityInput,
  record,
  recordId,
) {
  const identity = validateIdentity(identityInput);
  if (getRecordId(record) !== recordId) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      '记录标识与待删除目标不一致，拒绝删除',
    );
  }
  const fields = asFields(record);
  if (fieldText(fields['请求唯一ID']) !== identity.requestUniqueId) {
    throw new UnsafeOvertimeWorkflowCleanupError('请求唯一ID不一致，拒绝删除');
  }
  if (fieldText(fields['加班原因']) !== identity.marker) {
    throw new UnsafeOvertimeWorkflowCleanupError(
      '加班原因 marker 不一致，拒绝删除',
    );
  }
  if (fieldText(fields['请求指纹']) !== identity.fingerprint) {
    throw new UnsafeOvertimeWorkflowCleanupError('请求指纹不一致，拒绝删除');
  }
}

export function assertConfirmedWorkflowFields(record, expected) {
  const fields = asFields(record);
  const requiredLabels = [
    {
      field: '加班工作流状态',
      value: '已确认',
      assertionCode: 'WORKFLOW_STATE_MISMATCH',
      expectedValueCategory: 'terminal-confirmed',
    },
    {
      field: '加班审批',
      value: '同意',
      assertionCode: 'APPROVAL_DECISION_MISMATCH',
      expectedValueCategory: 'approved',
    },
    {
      field: '加班流程进展',
      value: '已确认',
      assertionCode: 'WORKFLOW_PROGRESS_MISMATCH',
      expectedValueCategory: 'terminal-confirmed',
    },
    {
      field: '加班确认',
      value: '确认',
      assertionCode: 'CONFIRMATION_STATE_MISMATCH',
      expectedValueCategory: 'confirmed',
    },
  ];
  for (const requirement of requiredLabels) {
    const raw = fields[requirement.field];
    const actual = fieldText(raw);
    if (actual !== requirement.value) {
      throwFieldAssertion({
        assertionCode: requirement.assertionCode,
        field: requirement.field,
        expectedType: 'single-select',
        expectedValueCategory: requirement.expectedValueCategory,
        actual: raw,
        actualValue: safeEnumValue(requirement.field, actual),
      });
    }
  }
  const dispositionRaw = fields['加班工时处置'];
  const disposition = fieldText(dispositionRaw);
  const expectedDisposition = expected.actualHours === 0 ? '' : '调休';
  if (disposition !== expectedDisposition) {
    throwFieldAssertion({
      assertionCode: 'DISPOSITION_MISMATCH',
      field: '加班工时处置',
      expectedType: 'single-select',
      expectedValueCategory:
        expected.actualHours === 0
          ? 'cleared-for-zero-hours'
          : 'compensatory-leave',
      actual: dispositionRaw,
      actualValue: safeEnumValue('加班工时处置', disposition),
    });
  }
  for (const requirement of [
    { field: '加班审批时间', assertionCode: 'APPROVAL_TIME_INVALID' },
    {
      field: '加班经理知会时间',
      assertionCode: 'MANAGER_NOTICE_TIME_INVALID',
    },
    { field: '加班确认时间', assertionCode: 'CONFIRMATION_TIME_INVALID' },
  ]) {
    const raw = fields[requirement.field];
    if (!Number.isFinite(fieldEpochMs(raw))) {
      throwFieldAssertion({
        assertionCode: requirement.assertionCode,
        field: requirement.field,
        expectedType: 'datetime',
        expectedValueCategory: 'finite-epoch',
        actual: raw,
        actualValue: safeDateValue(raw),
      });
    }
  }
  for (const requirement of [
    { field: '加班审批人', assertionCode: 'APPROVER_IDENTITY_MISMATCH' },
    { field: '加班确认人', assertionCode: 'CONFIRMER_IDENTITY_MISMATCH' },
  ]) {
    const raw = fields[requirement.field];
    const ids = fieldUserIds(raw);
    if (!ids.includes(expected.approverOpenId)) {
      throwFieldAssertion({
        assertionCode: requirement.assertionCode,
        field: requirement.field,
        expectedType: 'person-list',
        expectedValueCategory: 'contains-expected-actor',
        actual: raw,
        actualValue: `valid-person-count:${ids.length}`,
      });
    }
  }
  const actualStartRaw = fields['实际加班开始时间'];
  const actualEndRaw = fields['实际加班结束时间'];
  const actualStart = fieldEpochMs(actualStartRaw);
  const actualEnd = fieldEpochMs(actualEndRaw);
  const expectedStart = Date.parse(expected.actualStartAt);
  if (actualStart !== expectedStart) {
    throwFieldAssertion({
      assertionCode: 'ACTUAL_START_MISMATCH',
      field: '实际加班开始时间',
      expectedType: 'datetime',
      expectedValueCategory: 'matches-confirmation-start',
      actual: actualStartRaw,
      actualValue: safeDateComparison(actualStart, expectedStart),
    });
  }
  if (actualEnd !== expectedStart + expected.actualHours * HOUR_MS) {
    throwFieldAssertion({
      assertionCode: 'ACTUAL_END_MISMATCH',
      field: '实际加班结束时间',
      expectedType: 'datetime',
      expectedValueCategory: 'start-plus-confirmed-hours',
      actual: actualEndRaw,
      actualValue: safeDateComparison(
        actualEnd,
        expectedStart + expected.actualHours * HOUR_MS,
      ),
    });
  }
  for (const requirement of [
    { field: '实际加班时长', assertionCode: 'ACTUAL_HOURS_MISMATCH' },
    { field: '确认加班工时', assertionCode: 'CONFIRMED_HOURS_MISMATCH' },
  ]) {
    const raw = fields[requirement.field];
    const actual = fieldNumber(raw);
    if (actual !== expected.actualHours) {
      throwFieldAssertion({
        assertionCode: requirement.assertionCode,
        field: requirement.field,
        expectedType: 'number',
        expectedValueCategory: 'matches-confirmed-hours',
        actual: raw,
        actualValue: Number.isFinite(actual)
          ? `finite-number:${actual}`
          : 'invalid-number',
      });
    }
  }
  const workflowErrorRaw = fields['加班工作流错误'];
  if (fieldText(workflowErrorRaw)) {
    throwFieldAssertion({
      assertionCode: 'WORKFLOW_ERROR_NOT_EMPTY',
      field: '加班工作流错误',
      expectedType: 'text',
      expectedValueCategory: 'empty',
      actual: workflowErrorRaw,
      actualValue: 'non-empty-redacted',
    });
  }
}

export function normalizeVerifiedOvertimeNumberFields(record, schemas) {
  if (!isObject(record) || !isObject(record.fields)) {
    throw new TypeError('真实多维记录格式无效');
  }
  if (!Array.isArray(schemas)) {
    throw new TypeError('真实多维字段元数据格式无效');
  }
  const verifiedSchemas = new Map();
  for (const fieldName of VERIFIED_OVERTIME_NUMBER_FIELDS) {
    const matches = schemas.filter(
      (schema) => isObject(schema) && clean(schema.fieldName) === fieldName,
    );
    if (matches.length !== 1 || Number(matches[0].type) !== 2) {
      throw new TypeError(`${fieldName}必须是飞书 Number 字段`);
    }
    verifiedSchemas.set(fieldName, matches[0]);
  }

  const fields = { ...record.fields };
  for (const fieldName of verifiedSchemas.keys()) {
    if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) continue;
    fields[fieldName] = normalizeFeishuIntegerField(
      fields[fieldName],
      fieldName,
    );
  }
  return { ...record, fields };
}

function normalizeFeishuIntegerField(value, fieldName) {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 72
  ) {
    return value;
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 72) {
      return parsed;
    }
  }
  throw new TypeError(`${fieldName}不是规范的非负整数字段值`);
}

export function buildSafeWorkflowSelfTestError(error, stage = 'execute') {
  const safeStages = new Set([
    'arguments',
    'dependencies',
    'execute',
    'audit',
    'cleanup',
  ]);
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const phase = findWorkflowSelfTestErrorPhase(error);
  const assertion = findWorkflowSelfTestAssertion(error);
  let code =
    WORKFLOW_SELF_TEST_PHASE_CODES.get(phase) || 'WORKFLOW_SELF_TEST_FAILED';
  if (error instanceof UnsafeOvertimeWorkflowCleanupError) {
    code = 'UNSAFE_CLEANUP';
  } else if (error instanceof AggregateError) {
    code = 'WORKFLOW_AND_CLEANUP_FAILED';
  }
  const result = {
    ok: false,
    stage: safeStages.has(stage) ? stage : 'execute',
    code,
    safeRef: safeRef(`${name}\0${message}`),
  };
  return {
    ...result,
    ...(phase ? { phase } : {}),
    ...(assertion?.diagnostic || {}),
  };
}

async function runWorkflowSelfTestPhase(phase, operation) {
  if (!WORKFLOW_SELF_TEST_PHASE_CODES.has(phase)) {
    throw new TypeError('加班工作流自测阶段无效');
  }
  try {
    return await operation();
  } catch (error) {
    const phaseError = isWeakMapKey(error)
      ? error
      : new Error('加班工作流自测阶段失败');
    workflowSelfTestErrorPhases.set(phaseError, phase);
    throw phaseError;
  }
}

function findWorkflowSelfTestErrorPhase(error) {
  if (!isWeakMapKey(error)) return '';
  const direct = workflowSelfTestErrorPhases.get(error);
  if (WORKFLOW_SELF_TEST_PHASE_CODES.has(direct)) return direct;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const phase = findWorkflowSelfTestErrorPhase(nested);
      if (phase) return phase;
    }
  }
  return '';
}

function findWorkflowSelfTestAssertion(error) {
  if (error instanceof OvertimeWorkflowSelfTestAssertionError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const assertion = findWorkflowSelfTestAssertion(nested);
      if (assertion) return assertion;
    }
  }
  return null;
}

function throwFieldAssertion(input) {
  throw new OvertimeWorkflowSelfTestAssertionError({
    ...input,
    actualType: safeValueType(input.actual),
  });
}

function safeValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const itemTypes = [...new Set(value.map(safeValueType))].sort().join('|');
    return `array<${itemTypes || 'empty'}>`;
  }
  return typeof value;
}

function safeEnumValue(field, value) {
  const allowed = {
    加班工作流状态: new Set([
      '待路由',
      '待审批',
      '已审批',
      '已驳回',
      '待确认',
      '已确认',
    ]),
    加班审批: new Set(['同意', '驳回']),
    加班流程进展: new Set(['申请中', '已审批', '已确认']),
    加班工时处置: new Set(['调休', '费用结算']),
    加班确认: new Set(['确认', '需修改']),
  };
  if (!value) return 'empty';
  return allowed[field]?.has(value)
    ? `known-enum:${value}`
    : 'unknown-redacted';
}

function safeDateValue(value) {
  if (value === null || value === undefined || fieldText(value) === '') {
    return 'empty';
  }
  return Number.isFinite(fieldEpochMs(value))
    ? 'finite-epoch'
    : 'invalid-datetime';
}

function safeDateComparison(actual, expected) {
  if (!Number.isFinite(actual)) return 'invalid-datetime';
  if (!Number.isFinite(expected)) return 'expected-invalid';
  return actual < expected
    ? 'finite-epoch:before-expected'
    : 'finite-epoch:after-expected';
}

function inspectWorkflowSelfTestRecord(record) {
  const recordId = getRecordId(record);
  const fields = asFields(record);
  const requestUniqueId = fieldText(fields['请求唯一ID']);
  const marker = fieldText(fields['加班原因']);
  const fingerprint = fieldText(fields['请求指纹']).toLowerCase();
  const isCandidate =
    requestUniqueId.startsWith('overtime-workflow-selftest-') ||
    marker.startsWith('CODEX-SELFTEST-OVERTIME-WORKFLOW-');
  let identity = null;
  let identityValid = false;
  if (isCandidate) {
    try {
      identity = validateIdentity({ requestUniqueId, marker, fingerprint });
      const expectedFingerprint = createHash('sha256')
        .update('overtime-workflow-real-self-test-v1\0')
        .update(identity.requestUniqueId)
        .update('\0')
        .update(identity.marker)
        .digest('hex');
      identityValid =
        RECORD_ID_PATTERN.test(recordId) &&
        expectedFingerprint === identity.fingerprint;
    } catch {
      identity = null;
    }
  }
  return {
    recordId,
    recordRef: safeRef(recordId),
    isCandidate,
    identityValid,
    identity,
  };
}

async function resolveOvertimeBaseAccess(
  configModule,
  directModule,
  httpService,
) {
  const sourceUrl =
    configModule.readEnv('FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL', [
      'FEISHU_LEAVE_REQUEST_SOURCE_URL',
    ]) || DEFAULT_OVERTIME_SOURCE_URL;
  const parsedSource = configModule.parseFeishuBitableLink(sourceUrl);
  const configuredTableId =
    configModule.readEnv('FEISHU_OVERTIME_TABLE_ID', [
      'FEISHU_LEAVE_SUBSTITUTE_TABLE_ID',
      'FEISHU_LEAVE_REQUEST_TABLE_ID',
    ]) || parsedSource.tableId;
  if (configuredTableId !== OVERTIME_TABLE_ID) {
    throw new Error('加班工作流自测配置未指向固定目标表');
  }
  const configuredOvertimeAppToken = configModule.readEnv(
    'FEISHU_OVERTIME_APP_TOKEN',
    [
      'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
      'FEISHU_LEAVE_REQUEST_APP_TOKEN',
      'FEISHU_MAIN_APP_TOKEN',
      'FEISHU_BITABLE_APP_TOKEN',
    ],
  );
  const appToken = await directModule.resolveBitableAppToken(httpService, {
    appToken: configuredOvertimeAppToken || parsedSource.appToken,
    wikiToken:
      configModule.readEnv('FEISHU_LEAVE_SUBSTITUTE_WIKI_TOKEN', [
        'FEISHU_LEAVE_REQUEST_WIKI_TOKEN',
      ]) || parsedSource.wikiToken,
    tableName: '请休假与加班申请',
  });
  if (!configuredOvertimeAppToken) {
    process.env.FEISHU_OVERTIME_APP_TOKEN = appToken;
  }
  return { appToken };
}

async function createResidualAuditDependencies({ allowDelete = false } = {}) {
  await import('../dist/server/runtime-env.js');
  const [configModule, directModule, inventoryModule] = await Promise.all([
    import('../dist/server/common/config/external-services.config.js'),
    import('../dist/server/common/feishu/bitable-direct-read.js'),
    import('../dist/server/modules/inventory-management/inventory-workflow.gateway.js'),
  ]);
  const httpService = { axiosRef: axios };
  const { appToken } = await resolveOvertimeBaseAccess(
    configModule,
    directModule,
    httpService,
  );
  const inventoryGateway = new inventoryModule.InventoryWorkflowGateway(
    httpService,
  );
  const queryBaseByUniqueId = (requestUniqueId) =>
    directModule.fetchBitableRecords(httpService, {
      appToken,
      tableId: OVERTIME_TABLE_ID,
      tableName: '请休假与加班申请',
      fieldNames: BASE_IDENTITY_FIELDS,
      filter: {
        conjunction: 'and',
        conditions: [
          {
            field_name: '请求唯一ID',
            operator: 'is',
            value: [requestUniqueId],
          },
        ],
      },
      cacheTtlMs: 0,
      forceRefresh: true,
      allowStale: false,
      strict: true,
    });
  const dependencies = {
    listWorkflowSelfTestRecords: () =>
      directModule.fetchBitableRecords(httpService, {
        appToken,
        tableId: OVERTIME_TABLE_ID,
        tableName: '请休假与加班申请',
        fieldNames: BASE_IDENTITY_FIELDS,
        cacheTtlMs: 0,
        forceRefresh: true,
        allowStale: false,
        strict: true,
      }),
    queryBaseByUniqueId,
    readBaseRecord: (recordId) =>
      inventoryGateway.getRecord(
        appToken,
        OVERTIME_TABLE_ID,
        recordId,
        '请休假与加班申请',
      ),
  };
  if (allowDelete) {
    dependencies.deleteBaseRecord = (recordId) =>
      inventoryGateway.deleteRecord(
        appToken,
        OVERTIME_TABLE_ID,
        recordId,
        '请休假与加班申请',
      );
  }
  return dependencies;
}

async function createRealDependencies(options = {}) {
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
    import('../dist/server/modules/overtime-workflow/overtime-workflow.gateway.js'),
    import('../dist/server/modules/overtime-workflow/overtime-workflow.store.js'),
    import('../dist/server/modules/overtime-workflow/overtime-workflow.service.js'),
    import('../dist/server/modules/overtime-workflow/overtime-workflow.rules.js'),
  ]);
  const httpService = { axiosRef: axios };
  const { appToken } = await resolveOvertimeBaseAccess(
    configModule,
    directModule,
    httpService,
  );
  const inventoryGateway = new inventoryModule.InventoryWorkflowGateway(
    httpService,
  );
  const overtimeFieldSchemas = await inventoryGateway.getFieldSchemas(
    appToken,
    OVERTIME_TABLE_ID,
    '请休假与加班申请',
  );
  normalizeVerifiedOvertimeNumberFields({ fields: {} }, overtimeFieldSchemas);

  const tempDirectory = await mkdtemp(
    join(tmpdir(), 'overtime-workflow-real-self-test-'),
  );
  const ledgerPath = join(tempDirectory, 'ledger.json');
  const store = new workflowStoreModule.OvertimeWorkflowStore(ledgerPath);
  try {
    await store.onModuleInit();
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
  const realGateway = new workflowGatewayModule.OvertimeWorkflowGateway(
    httpService,
  );
  const fakeCards = { sent: [], patched: [] };
  let messageSequence = 0;

  const personnel = {
    getCachedActivePersonnelDirectory: async () => {
      const orgAppToken = configModule.readEnv('FEISHU_ORG_APP_TOKEN', [
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
      const snapshot =
        await directModule.readLatestPersistedBitableRecordSnapshot({
          appToken: orgAppToken || undefined,
          tableId,
          viewId,
          tableName: '在职人员',
        });
      if (!snapshot) {
        throw new Error('在职人员本地快照尚未就绪，不能安全执行工作流自测');
      }
      return activeModule.buildActivePersonnelDirectory(snapshot);
    },
  };
  const fakeGateway = {
    fetchOrganizationRoutingRecords: (...args) =>
      realGateway.fetchOrganizationRoutingRecords(...args),
    updateOvertimeRecord: (...args) =>
      realGateway.updateOvertimeRecord(...args),
    readOvertimeRecord: (...args) => realGateway.readOvertimeRecord(...args),
    issueConfirmationTicket: (...args) =>
      realGateway.issueConfirmationTicket(...args),
    verifyConfirmationTicket: (...args) =>
      realGateway.verifyConfirmationTicket(...args),
    buildConfirmationUrl: (recordId) =>
      `https://self-test.invalid/overtime-confirmation/${safeRef(recordId)}`,
    sendInteractiveCard: async (recipientOpenId, card, businessKey) => {
      messageSequence += 1;
      const messageId = `om_selftest_${String(messageSequence).padStart(4, '0')}`;
      fakeCards.sent.push({
        recipientRef: safeRef(recipientOpenId),
        businessRef: safeRef(businessKey),
        stage: workflowCardStageFromBusinessKey(businessKey),
        messageId,
        cardBytes: Buffer.byteLength(JSON.stringify(card), 'utf8'),
      });
      return messageId;
    },
    patchInteractiveCard: async (messageId, card) => {
      const delivery = fakeCards.sent.find(
        (entry) => entry.messageId === messageId,
      );
      const stage =
        delivery?.stage === 'approvalCards' ||
        delivery?.stage === 'confirmationCards'
          ? delivery.stage
          : '';
      const parsedCard = assertWorkflowTerminalCardPatch(stage, card);
      fakeCards.patched.push({
        messageId,
        messageRef: safeRef(messageId),
        stage,
        terminalValid: true,
        cardBytes: Buffer.byteLength(JSON.stringify(parsedCard), 'utf8'),
      });
    },
  };
  const service = new workflowServiceModule.OvertimeWorkflowService(
    store,
    fakeGateway,
    personnel,
  );
  const fixedCandidate = options.candidate
    ? validateMatrixCandidate(options.candidate)
    : null;

  const discoverMatrixCandidates = async () => {
    const [organizationRecords, directory] = await Promise.all([
      realGateway.fetchOrganizationRoutingRecords(true),
      personnel.getCachedActivePersonnelDirectory(),
    ]);
    return selectOvertimeWorkflowMatrixCandidates({
      personnel: directory.personnel,
      organizationRecords,
      managerRecipients: directory.managers,
      resolveRoute: workflowRulesModule.resolveOvertimeApprovalRoute,
    });
  };

  const queryBaseByUniqueId = (requestUniqueId) =>
    directModule.fetchBitableRecords(httpService, {
      appToken,
      tableId: OVERTIME_TABLE_ID,
      tableName: '请休假与加班申请',
      fieldNames: BASE_VERIFICATION_FIELDS,
      filter: {
        conjunction: 'and',
        conditions: [
          {
            field_name: '请求唯一ID',
            operator: 'is',
            value: [requestUniqueId],
          },
        ],
      },
      cacheTtlMs: 0,
      forceRefresh: true,
      allowStale: false,
      strict: true,
    });

  return {
    now: () => new Date(),
    randomUUID: () => createRandomUUID(),
    selectCandidate: async (range) => {
      if (fixedCandidate) {
        return { ...fixedCandidate, ...range, plannedHours: 1 };
      }
      const selection = await discoverMatrixCandidates();
      const candidate = selection.candidates.find(
        (entry) => entry.routeKind !== 'manager_group',
      );
      if (candidate) return { ...candidate, ...range, plannedHours: 1 };
      throw new Error('当前组织架构中没有可安全验证的唯一普通人员审批路由');
    },
    discoverMatrixCandidates,
    createBaseRecord: ({ identity, candidate }) =>
      inventoryGateway.createRecord(
        appToken,
        OVERTIME_TABLE_ID,
        {
          加班人员: [{ id: candidate.staffOpenId }],
          加班人员姓名: candidate.staffName,
          加班开始时间: Date.parse(candidate.plannedStartAt),
          加班结束时间: Date.parse(candidate.plannedEndAt),
          加班时长: candidate.plannedHours,
          加班原因: identity.marker,
          请求唯一ID: identity.requestUniqueId,
          请求指纹: identity.fingerprint,
          加班流程进展: '申请中',
          审批进度: '审批中',
          加班工作流状态: '待路由',
          加班工作流错误: '',
        },
        '请休假与加班申请',
      ),
    acceptApplication: ({ identity, candidate, recordId }) => {
      const impact = {
        rawHours: candidate.plannedHours,
        payableHours: candidate.plannedHours,
        conflictingSchedules: [],
        isWholeHour: true,
        invalidRangeReason: null,
        canSubmit: true,
      };
      return service.acceptApplication({
        request: {
          clientMutationId: identity.requestUniqueId,
          staffName: candidate.staffName,
          startAt: candidate.plannedStartAt,
          endAt: candidate.plannedEndAt,
          reason: identity.marker,
          expectedImpact: impact,
        },
        result: {
          success: true,
          created: 1,
          recordId,
          clientMutationId: identity.requestUniqueId,
          requestFingerprint: identity.fingerprint,
          impact,
          message: 'self-test',
        },
      });
    },
    runPendingTasks: (now) => service.runPendingTasks(now, 100),
    getApplication: (recordId) => store.getApplication(recordId),
    acceptApproval: ({ eventId, recordId, approver, application }) => {
      const approvalCard = application.approvalCards.find(
        (delivery) => delivery.recipientOpenId === approver.openId,
      );
      if (!approvalCard?.messageId) {
        throw new Error('未找到审批人已投递的测试卡片');
      }
      return service.acceptApprovalAction({
        eventId,
        recordId,
        action: 'approve',
        actorOpenId: approver.openId,
        actorName: approver.name,
        messageId: approvalCard.messageId,
      });
    },
    enqueueDueConfirmationReminders: async (recordId, now) => {
      const before = await store.getApplication(recordId);
      const beforeCount = countInitialConfirmationCards(before);
      if (beforeCount > 0) return beforeCount;
      await service.runPendingTasks(now, 100);
      const after = await store.getApplication(recordId);
      return countInitialConfirmationCards(after);
    },
    submitConfirmation: (input) => {
      const ticket = realGateway.issueConfirmationTicket({
        recordId: input.recordId,
        approverOpenId: input.approver.openId,
      });
      return service.submitConfirmation({
        recordId: input.recordId,
        ticket,
        mutationId: input.mutationId,
        actualStartAt: input.actualStartAt,
        actualHours: input.actualHours,
        disposition: input.disposition,
      });
    },
    readBaseRecord: (recordId) =>
      inventoryGateway.getRecord(
        appToken,
        OVERTIME_TABLE_ID,
        recordId,
        '请休假与加班申请',
      ),
    normalizeBaseRecordForVerification: (record) =>
      normalizeVerifiedOvertimeNumberFields(record, overtimeFieldSchemas),
    queryBaseByUniqueId,
    deleteBaseRecord: (recordId) =>
      inventoryGateway.deleteRecord(
        appToken,
        OVERTIME_TABLE_ID,
        recordId,
        '请休假与加班申请',
      ),
    cleanupLedger: () => rm(tempDirectory, { recursive: true, force: true }),
    evidence: () => ({
      fakeCardSendCount: fakeCards.sent.length,
      fakeCardStageCounts: fakeCards.sent.reduce(
        (counts, delivery) => {
          if (delivery.stage) counts[delivery.stage] += 1;
          return counts;
        },
        {
          approvalCards: 0,
          managerNoticeCards: 0,
          confirmationCards: 0,
          confirmationResultCards: 0,
        },
      ),
      fakeCardPatchCount: fakeCards.patched.length,
      fakeCardPatchStageCounts: fakeCards.patched.reduce(
        (counts, delivery) => {
          if (delivery.stage) counts[delivery.stage] += 1;
          return counts;
        },
        { approvalCards: 0, confirmationCards: 0 },
      ),
      fakeCardPatchCoverageExact:
        hasExactActionableCardPatchCoverage(fakeCards),
    }),
  };
}

function assertDependencies(deps) {
  const methods = [
    'selectCandidate',
    'createBaseRecord',
    'acceptApplication',
    'runPendingTasks',
    'getApplication',
    'acceptApproval',
    'enqueueDueConfirmationReminders',
    'submitConfirmation',
    'readBaseRecord',
    'queryBaseByUniqueId',
    'deleteBaseRecord',
    'cleanupLedger',
  ];
  if (
    !isObject(deps) ||
    methods.some((method) => typeof deps[method] !== 'function')
  ) {
    throw new TypeError('加班工作流真实自测依赖不完整');
  }
}

function validateIdentity(value) {
  const identity = isObject(value) ? value : {};
  const requestUniqueId = clean(identity.requestUniqueId);
  const marker = clean(identity.marker);
  const fingerprint = clean(identity.fingerprint).toLowerCase();
  if (
    !UNIQUE_ID_PATTERN.test(requestUniqueId) ||
    !MARKER_PATTERN.test(marker) ||
    !FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    throw new TypeError('加班工作流自测身份标记无效');
  }
  return { requestUniqueId, marker, fingerprint };
}

function validateCandidate(value, expectedRange) {
  const candidate = isObject(value) ? value : {};
  const result = {
    staffName: clean(candidate.staffName),
    staffOpenId: clean(candidate.staffOpenId),
    building: clean(candidate.building),
    position: clean(candidate.position),
    plannedStartAt: clean(candidate.plannedStartAt),
    plannedEndAt: clean(candidate.plannedEndAt),
    plannedHours: Number(candidate.plannedHours),
  };
  if (
    !result.staffName ||
    !OPEN_ID_PATTERN.test(result.staffOpenId) ||
    result.plannedStartAt !== expectedRange.plannedStartAt ||
    result.plannedEndAt !== expectedRange.plannedEndAt ||
    !Number.isInteger(result.plannedHours) ||
    result.plannedHours < 1 ||
    result.plannedHours > 72
  ) {
    throw new Error('真实组织架构候选人员或自测时段无效');
  }
  return result;
}

function validateMatrixCandidate(value) {
  const candidate = isObject(value) ? value : {};
  const result = {
    scenario: clean(candidate.scenario),
    routeKind: clean(candidate.routeKind),
    staffName: clean(candidate.staffName),
    staffOpenId: clean(candidate.staffOpenId),
    building: normalizeMatrixBuilding(candidate.building),
    position: clean(candidate.position),
    expectedApproverOpenIds: normalizeExpectedOpenIds(
      candidate.expectedApproverOpenIds,
      '预期审批人',
    ),
    expectedManagerOpenIds: normalizeExpectedOpenIds(
      candidate.expectedManagerOpenIds,
      '预期机房经理',
    ),
  };
  const target = OVERTIME_MATRIX_TARGETS.find(
    (entry) => entry.scenario === result.scenario,
  );
  if (
    !target ||
    target.routeKind !== result.routeKind ||
    !result.staffName ||
    !OPEN_ID_PATTERN.test(result.staffOpenId) ||
    !result.building
  ) {
    throw new Error('多楼栋真实自测候选场景无效');
  }
  if (target.building && target.building !== result.building) {
    throw new Error('多楼栋真实自测候选楼栋与审批路由不匹配');
  }
  return result;
}

function assertMatrixCoverage(candidates) {
  const distinctBuildings = new Set(
    candidates.map((candidate) => candidate.building),
  );
  const hasRequiredSpecialRoute = candidates.some((candidate) =>
    ['h_duty_supervisor', 'station_110_electrical_supervisor'].includes(
      candidate.routeKind,
    ),
  );
  const identities = new Set(
    candidates.map((candidate) => candidate.staffOpenId),
  );
  if (
    candidates.length < 3 ||
    distinctBuildings.size < 3 ||
    identities.size !== candidates.length ||
    !hasRequiredSpecialRoute
  ) {
    throw new Error('真实组织架构不足以覆盖至少三个不同楼栋且包含H楼或110站');
  }
}

function assertMatrixScenarioResult(candidate, result, expectZeroHours) {
  const value = isObject(result) ? result : {};
  const approverCount = finiteCount(value.approverCount);
  const managerRecipientCount = finiteCount(value.managerRecipientCount);
  const approvalCardCount = finiteCount(value.approvalCardCount);
  const managerNoticeCardCount = finiteCount(value.managerNoticeCardCount);
  const confirmationRecipientCount = finiteCount(
    value.confirmationRecipientCount,
  );
  const initialConfirmationCardCount = finiteCount(
    value.initialConfirmationCardCount,
  );
  const confirmationResultCardCount = finiteCount(
    value.confirmationResultCardCount,
  );
  const fakeCardSendCount = finiteCount(value.fakeCardSendCount);
  const expectedCardSendCount = finiteCount(value.expectedCardSendCount);
  const fakeCardStageCounts = normalizeWorkflowCardStageCounts(
    value.fakeCardStageCounts,
  );
  const fakeCardPatchCount = finiteCount(value.fakeCardPatchCount);
  const fakeCardPatchStageCounts = normalizeWorkflowCardPatchStageCounts(
    value.fakeCardPatchStageCounts,
  );
  const fakeCardPatchCoverageExact = value.fakeCardPatchCoverageExact === true;
  const approverOpenIds = normalizeExpectedOpenIds(
    value.approverOpenIds,
    '实际审批人',
  );
  const managerRecipientOpenIds = normalizeExpectedOpenIds(
    value.managerRecipientOpenIds,
    '实际机房经理',
  );
  const actualHours = Number(value.actualHours);
  const stageSendCount =
    approvalCardCount +
    managerNoticeCardCount +
    initialConfirmationCardCount +
    confirmationResultCardCount;
  if (
    value.ok !== true ||
    value.cleaned !== true ||
    Number(value.residualCount) !== 0 ||
    value.workflowState !== 'confirmed' ||
    approverCount < 1 ||
    managerRecipientCount < 1 ||
    confirmationRecipientCount < 1 ||
    approvalCardCount !== approverCount ||
    initialConfirmationCardCount !== 1 ||
    confirmationResultCardCount !== confirmationRecipientCount - 1 ||
    expectedCardSendCount !== stageSendCount ||
    fakeCardSendCount !== expectedCardSendCount ||
    fakeCardStageCounts.approvalCards !== approvalCardCount ||
    fakeCardStageCounts.managerNoticeCards !== managerNoticeCardCount ||
    fakeCardStageCounts.confirmationCards !== initialConfirmationCardCount ||
    fakeCardStageCounts.confirmationResultCards !==
      confirmationResultCardCount ||
    fakeCardPatchCount !== approvalCardCount + initialConfirmationCardCount ||
    fakeCardPatchStageCounts.approvalCards !== approvalCardCount ||
    fakeCardPatchStageCounts.confirmationCards !==
      initialConfirmationCardCount ||
    !fakeCardPatchCoverageExact ||
    !sameOpenIdSet(approverOpenIds, candidate.expectedApproverOpenIds) ||
    !sameOpenIdSet(managerRecipientOpenIds, candidate.expectedManagerOpenIds) ||
    (expectZeroHours ? actualHours !== 0 : !(actualHours > 0))
  ) {
    throw new Error(
      `多楼栋真实自测场景 ${candidate.scenario} 未完整覆盖审批、结果去重通知、确认及清理`,
    );
  }
}

export function expectedWorkflowCardSendCount(application) {
  return assertWorkflowCardDeliveryCoverage(application).expectedCardSendCount;
}

export function assertWorkflowTerminalCardPatch(stage, card) {
  let parsed;
  try {
    const serialized = JSON.stringify(card);
    if (!serialized) throw new Error('empty');
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('内存模拟卡片 patch 不是有效 JSON');
  }
  if (!isObject(parsed) || parsed.schema !== '2.0') {
    throw new Error('内存模拟卡片 patch 缺少 schema 2.0');
  }
  if (
    parsed.header?.title?.tag !== 'plain_text' ||
    !Array.isArray(parsed.body?.elements) ||
    parsed.body.elements.length === 0
  ) {
    throw new Error('内存模拟终态卡缺少标题或只读正文');
  }
  if (containsForbiddenCardAction(parsed)) {
    throw new Error('内存模拟终态卡仍包含 callback 或 action');
  }
  const title = clean(parsed.header?.title?.content);
  const buttons = collectCardNodesByTag(parsed, 'button');
  if (stage === 'approvalCards') {
    if (!['加班申请审批通过', '加班申请审批驳回'].includes(title)) {
      throw new Error('审批卡 patch 不是对应审批终态');
    }
    const labels = buttons.map((button) => clean(button.text?.content)).sort();
    if (
      containsDisallowedCardTag(
        parsed,
        new Set(['plain_text', 'markdown', 'column_set', 'column', 'button']),
      ) ||
      buttons.length !== 2 ||
      buttons.some((button) => button.disabled !== true) ||
      buttons.some((button) => button.type !== 'default') ||
      buttons.some((button) =>
        ['behaviors', 'value', 'url', 'name'].some((key) =>
          Object.prototype.hasOwnProperty.call(button, key),
        ),
      ) ||
      labels.join('\0') !== ['同意', '驳回'].sort().join('\0')
    ) {
      throw new Error('审批终态卡必须保留两个灰显禁用按钮');
    }
  } else if (stage === 'confirmationCards') {
    if (!['加班信息已确认', '加班已取消'].includes(title)) {
      throw new Error('确认卡 patch 不是对应确认终态');
    }
    if (
      buttons.length !== 0 ||
      containsDisallowedCardTag(
        parsed,
        new Set(['plain_text', 'lark_md', 'div']),
      )
    ) {
      throw new Error('确认终态卡必须是无按钮只读卡');
    }
  } else {
    throw new Error('内存模拟卡片 patch 未匹配可操作卡阶段');
  }
  return parsed;
}

export function assertWorkflowCardDeliveryCoverage(application) {
  if (!isObject(application)) throw new Error('加班工作流账本无效');
  const recordId = clean(application.recordId);
  if (!RECORD_ID_PATTERN.test(recordId)) {
    throw new Error('加班工作流缺少有效记录标识');
  }
  const applicantOpenId = clean(application.snapshot?.applicantOpenId);
  if (!OPEN_ID_PATTERN.test(applicantOpenId)) {
    throw new Error('加班工作流缺少有效申请人');
  }
  const approvalRecipientIds = collectRouteRecipientIds(
    application.approvers,
    '原审批人',
    true,
  );
  const managerRecipientIds = collectRouteRecipientIds(
    application.managerRecipients,
    '机房经理',
  );
  const resultRecipientIds = new Set([
    applicantOpenId,
    ...approvalRecipientIds,
    ...managerRecipientIds,
  ]);
  const actualApproverOpenId = clean(application.actualApproverOpenId);
  if (!approvalRecipientIds.has(actualApproverOpenId)) {
    throw new Error('实际审批人不在原审批人范围内');
  }

  const approvalCards = assertExactWorkflowDeliveryStage({
    value: application.approvalCards,
    label: '加班审批卡',
    expectedRecipientIds: approvalRecipientIds,
    expectedBusinessKey: (openId) => `overtime:${recordId}:approval:${openId}`,
  });
  const approvalResultRecipientIds = new Set(
    [...resultRecipientIds].filter(
      (openId) => !approvalRecipientIds.has(openId),
    ),
  );
  const managerNoticeCards = assertExactWorkflowDeliveryStage({
    value: application.managerNoticeCards,
    label: '加班审批结果补发卡',
    expectedRecipientIds: approvalResultRecipientIds,
    expectedBusinessKey: (openId) =>
      `overtime:${recordId}:approval-result:${openId}`,
  });
  const confirmationCards = assertExactWorkflowDeliveryStage({
    value: application.confirmationCards,
    label: '初始加班确认卡',
    expectedRecipientIds: new Set([actualApproverOpenId]),
    expectedBusinessKey: () => `overtime-confirm:${recordId}:initial`,
  });
  const confirmationCardHolders = new Set(
    confirmationCards.map((entry) => entry.recipientOpenId),
  );
  const confirmationResultRecipientIds = new Set(
    [...resultRecipientIds].filter(
      (openId) => !confirmationCardHolders.has(openId),
    ),
  );
  const confirmationResultCards = assertExactWorkflowDeliveryStage({
    value: application.confirmationResultCards,
    label: '加班确认结果卡',
    expectedRecipientIds: confirmationResultRecipientIds,
    expectedBusinessKey: (openId) =>
      `overtime:${recordId}:confirmation-result:${openId}`,
  });
  const expectedCardSendCount =
    approvalCards.length +
    managerNoticeCards.length +
    confirmationCards.length +
    confirmationResultCards.length;

  return {
    approvalCardCount: approvalCards.length,
    managerNoticeCardCount: managerNoticeCards.length,
    initialConfirmationCardCount: confirmationCards.length,
    confirmationResultCardCount: confirmationResultCards.length,
    confirmationRecipientCount: resultRecipientIds.size,
    expectedCardSendCount,
  };
}

export function assertWorkflowCardSendEvidence(coverage, evidence) {
  if (!isObject(coverage) || !isObject(evidence)) {
    throw new Error('内存模拟卡片发送证据无效');
  }
  const expectedStageCounts = {
    approvalCards: finiteCount(coverage.approvalCardCount),
    managerNoticeCards: finiteCount(coverage.managerNoticeCardCount),
    confirmationCards: finiteCount(coverage.initialConfirmationCardCount),
    confirmationResultCards: finiteCount(coverage.confirmationResultCardCount),
  };
  const actualStageCounts = normalizeWorkflowCardStageCounts(
    evidence.fakeCardStageCounts,
  );
  const expectedTotal = Object.values(expectedStageCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const actualTotal = finiteCount(evidence.fakeCardSendCount);
  const expectedPatchStageCounts = {
    approvalCards: finiteCount(coverage.approvalCardCount),
    confirmationCards: finiteCount(coverage.initialConfirmationCardCount),
  };
  const actualPatchStageCounts = normalizeWorkflowCardPatchStageCounts(
    evidence.fakeCardPatchStageCounts,
  );
  const expectedPatchTotal = Object.values(expectedPatchStageCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const actualPatchTotal = finiteCount(evidence.fakeCardPatchCount);
  if (
    finiteCount(coverage.expectedCardSendCount) !== expectedTotal ||
    actualTotal !== expectedTotal ||
    Object.keys(expectedStageCounts).some(
      (stage) => actualStageCounts[stage] !== expectedStageCounts[stage],
    ) ||
    actualPatchTotal !== expectedPatchTotal ||
    evidence.fakeCardPatchCoverageExact !== true ||
    Object.keys(expectedPatchStageCounts).some(
      (stage) =>
        actualPatchStageCounts[stage] !== expectedPatchStageCounts[stage],
    )
  ) {
    throw new Error('内存模拟卡片各阶段发送或终态更新量与工作流账本不一致');
  }
  return actualStageCounts;
}

export function assertConfirmationResultDeliveryCoverage(application) {
  const coverage = assertWorkflowCardDeliveryCoverage(application);
  return {
    recipientCount: coverage.confirmationRecipientCount,
    initialConfirmationCardCount: coverage.initialConfirmationCardCount,
    confirmationResultCardCount: coverage.confirmationResultCardCount,
  };
}

function collectRouteRecipientIds(value, label, requireNonEmpty = false) {
  if (!Array.isArray(value)) throw new Error(`${label}列表无效`);
  const recipientIds = value.map((entry) => clean(entry?.openId));
  if (recipientIds.some((openId) => !OPEN_ID_PATTERN.test(openId))) {
    throw new Error(`${label}包含无效 Open ID`);
  }
  const uniqueRecipientIds = new Set(recipientIds);
  if (uniqueRecipientIds.size !== recipientIds.length) {
    throw new Error(`${label}包含重复 Open ID`);
  }
  if (requireNonEmpty && uniqueRecipientIds.size === 0) {
    throw new Error(`${label}不能为空`);
  }
  return uniqueRecipientIds;
}

function normalizeWorkflowCardStageCounts(value) {
  const source = isObject(value) ? value : null;
  const count = (stage) => {
    if (!source) return -1;
    const parsed = Number(source[stage]);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
  };
  return {
    approvalCards: count('approvalCards'),
    managerNoticeCards: count('managerNoticeCards'),
    confirmationCards: count('confirmationCards'),
    confirmationResultCards: count('confirmationResultCards'),
  };
}

function normalizeWorkflowCardPatchStageCounts(value) {
  const source = isObject(value) ? value : null;
  const count = (stage) => {
    if (!source) return -1;
    const parsed = Number(source[stage]);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
  };
  return {
    approvalCards: count('approvalCards'),
    confirmationCards: count('confirmationCards'),
  };
}

function normalizeExpectedOpenIds(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}列表无效`);
  const openIds = value.map((entry) =>
    clean(typeof entry === 'string' ? entry : entry?.openId),
  );
  if (
    openIds.length === 0 ||
    openIds.some((openId) => !OPEN_ID_PATTERN.test(openId)) ||
    new Set(openIds).size !== openIds.length
  ) {
    throw new Error(`${label}必须是非空且不重复的有效 Open ID 列表`);
  }
  return openIds;
}

function sameOpenIdSet(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((openId) => expected.includes(openId))
  );
}

export function hasExactActionableCardPatchCoverage(fakeCards) {
  if (
    !isObject(fakeCards) ||
    !Array.isArray(fakeCards.sent) ||
    !Array.isArray(fakeCards.patched)
  ) {
    return false;
  }
  const actionable = fakeCards.sent.filter(
    (delivery) =>
      delivery?.stage === 'approvalCards' ||
      delivery?.stage === 'confirmationCards',
  );
  const actionableByMessageId = new Map();
  for (const delivery of actionable) {
    const messageId = clean(delivery?.messageId);
    if (!messageId || actionableByMessageId.has(messageId)) return false;
    actionableByMessageId.set(messageId, delivery);
  }
  if (fakeCards.patched.length !== actionableByMessageId.size) return false;

  const patchedMessageIds = new Set();
  for (const patch of fakeCards.patched) {
    const messageId = clean(patch?.messageId);
    const original = actionableByMessageId.get(messageId);
    if (
      !messageId ||
      patchedMessageIds.has(messageId) ||
      !original ||
      patch?.stage !== original.stage ||
      patch?.terminalValid !== true
    ) {
      return false;
    }
    patchedMessageIds.add(messageId);
  }
  return patchedMessageIds.size === actionableByMessageId.size;
}

function containsForbiddenCardAction(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenCardAction);
  if (!isObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      ['action', 'actions', 'behavior', 'behaviors', 'callback'].includes(
        normalizedKey,
      )
    ) {
      return true;
    }
    if (
      normalizedKey === 'type' &&
      ['callback', 'open_url', 'form_submit', 'submit', 'url'].includes(
        clean(nested),
      )
    ) {
      return true;
    }
    if (containsForbiddenCardAction(nested)) return true;
  }
  return false;
}

function collectCardNodesByTag(value, tag, result = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectCardNodesByTag(entry, tag, result));
    return result;
  }
  if (!isObject(value)) return result;
  if (value.tag === tag) result.push(value);
  Object.values(value).forEach((entry) =>
    collectCardNodesByTag(entry, tag, result),
  );
  return result;
}

function containsDisallowedCardTag(value, allowedTags) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsDisallowedCardTag(entry, allowedTags));
  }
  if (!isObject(value)) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, 'tag') &&
    !allowedTags.has(clean(value.tag))
  ) {
    return true;
  }
  return Object.values(value).some((entry) =>
    containsDisallowedCardTag(entry, allowedTags),
  );
}

function assertExactWorkflowDeliveryStage({
  value,
  label,
  expectedRecipientIds,
  expectedBusinessKey,
}) {
  if (!Array.isArray(value)) throw new Error(`${label}投递账本无效`);
  const deliveries = normalizeWorkflowDeliveries(value);
  if (deliveries.length !== value.length) {
    throw new Error(`${label}投递账本包含无效记录`);
  }
  const recipientIds = deliveries.map((entry) => entry.recipientOpenId);
  if (new Set(recipientIds).size !== recipientIds.length) {
    throw new Error(`${label}存在重复收件人`);
  }
  if (
    new Set(deliveries.map((entry) => entry.businessKey)).size !==
    deliveries.length
  ) {
    throw new Error(`${label}存在重复业务键`);
  }
  if (
    recipientIds.length !== expectedRecipientIds.size ||
    recipientIds.some((openId) => !expectedRecipientIds.has(openId)) ||
    [...expectedRecipientIds].some((openId) => !recipientIds.includes(openId))
  ) {
    throw new Error(`${label}收件人与理论范围不一致`);
  }
  for (const delivery of deliveries) {
    if (
      delivery.businessKey !== expectedBusinessKey(delivery.recipientOpenId)
    ) {
      throw new Error(`${label}业务键与收件人不一致`);
    }
  }
  return deliveries;
}

function normalizeWorkflowDeliveries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      recipientOpenId: clean(entry?.recipientOpenId),
      messageId: clean(entry?.messageId),
      businessKey: clean(entry?.businessKey),
    }))
    .filter(
      (entry) =>
        OPEN_ID_PATTERN.test(entry.recipientOpenId) &&
        entry.messageId.length > 0 &&
        entry.businessKey.length > 0,
    );
}

function sanitizeMatrixSkipped(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      scenario: clean(entry?.scenario),
      reason: clean(entry?.reason) || 'NO_MATCHING_ROUTE',
    }))
    .filter((entry) =>
      OVERTIME_MATRIX_TARGETS.some(
        (target) => target.scenario === entry.scenario,
      ),
    );
}

function normalizeMatrixBuilding(value) {
  const label = clean(value).replace(/\s+/gu, '').toUpperCase();
  if (['A', 'A楼', 'A栋'].includes(label)) return 'A楼';
  if (['B', 'B楼', 'B栋'].includes(label)) return 'B楼';
  if (['C', 'C楼', 'C栋'].includes(label)) return 'C楼';
  if (['D', 'D楼', 'D栋'].includes(label)) return 'D楼';
  if (['E', 'E楼', 'E栋'].includes(label)) return 'E楼';
  if (['H', 'H楼', 'H栋'].includes(label)) return 'H楼';
  if (label === '110' || label.includes('110站')) return '110站';
  return label;
}

function validateApplication(value, expectedPhase) {
  if (!isObject(value) || value.phase !== expectedPhase) {
    throw new Error(`本地工作流状态未进入 ${expectedPhase}`);
  }
  const approvers = Array.isArray(value.approvers)
    ? value.approvers.filter(
        (entry) => isObject(entry) && OPEN_ID_PATTERN.test(clean(entry.openId)),
      )
    : [];
  const managerRecipients = Array.isArray(value.managerRecipients)
    ? value.managerRecipients.filter(
        (entry) => isObject(entry) && OPEN_ID_PATTERN.test(clean(entry.openId)),
      )
    : [];
  if (approvers.length < 1) {
    throw new Error('工作流未解析出有效审批人');
  }
  return { ...value, approvers, managerRecipients };
}

function validateRecordId(value) {
  const recordId = clean(value);
  return RECORD_ID_PATTERN.test(recordId) ? recordId : '';
}

function requireRecordId(value) {
  const recordId = validateRecordId(value);
  if (!recordId) throw new Error('真实多维创建响应缺少有效 recordId');
  return recordId;
}

function resolveDate(value, message) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(message);
  return date;
}

function resolveExecutionNow(deps) {
  return resolveDate(deps.now?.() ?? new Date(), '任务扫描时间无效');
}

function floorToHour(date) {
  const value = new Date(date);
  value.setUTCMinutes(0, 0, 0);
  return value;
}

function formatShanghaiIso(date) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

function asFields(record) {
  return isObject(record?.fields) ? record.fields : {};
}

function getRecordId(record) {
  return clean(record?.record_id || record?.recordId || record?.id);
}

function fieldText(value) {
  return displayValues(value).join('').trim();
}

function displayValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(displayValues);
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text ? [text] : [];
  }
  if (isObject(value)) {
    for (const key of ['text', 'name', 'value', 'option', 'user_name']) {
      const nested = displayValues(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function fieldUserIds(value) {
  const ids = [];
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isObject(candidate)) return;
    for (const key of ['id', 'open_id', 'openId', 'user_id']) {
      const id = clean(candidate[key]);
      if (id) {
        ids.push(id);
        break;
      }
    }
    if (Array.isArray(candidate.users)) candidate.users.forEach(visit);
  };
  visit(value);
  return [...new Set(ids)];
}

function fieldEpochMs(value) {
  const candidate =
    Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof candidate === 'number' && Number.isFinite(candidate))
    return candidate;
  if (typeof candidate === 'string') {
    const parsed = /^\d+$/u.test(candidate)
      ? Number(candidate)
      : Date.parse(candidate);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isObject(candidate)) {
    for (const key of ['timestamp', 'date', 'value', 'text']) {
      const parsed = fieldEpochMs(candidate[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function fieldNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteCount(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function countInitialConfirmationCards(application) {
  const deliveries = Array.isArray(application?.confirmationCards)
    ? application.confirmationCards
    : [];
  return deliveries.filter((delivery) =>
    clean(delivery?.businessKey).endsWith(':initial'),
  ).length;
}

function workflowCardStageFromBusinessKey(value) {
  const businessKey = clean(value);
  if (businessKey.includes(':approval-result:')) return 'managerNoticeCards';
  if (businessKey.includes(':confirmation-result:'))
    return 'confirmationResultCards';
  if (businessKey.endsWith(':initial')) return 'confirmationCards';
  if (businessKey.includes(':approval:')) return 'approvalCards';
  return '';
}

function safeRef(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWeakMapKey(value) {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

function printSafe(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseArguments(args) {
  const allowed = new Set([
    '--dry-run',
    '--apply-real',
    '--audit-only',
    '--cleanup-only',
  ]);
  if (args.some((arg) => !allowed.has(arg))) {
    throw new Error(
      '仅支持 --dry-run、--apply-real、--audit-only 或 --cleanup-only',
    );
  }
  const selectedModes = [...allowed].filter((flag) => args.includes(flag));
  if (selectedModes.length > 1) {
    throw new Error('自测运行模式不能同时使用');
  }
  const mode = args.includes('--apply-real')
    ? 'apply-real'
    : args.includes('--audit-only')
      ? 'audit-only'
      : args.includes('--cleanup-only')
        ? 'cleanup-only'
        : 'dry-run';
  return { mode };
}

async function main() {
  let stage = 'arguments';
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.mode === 'dry-run') {
      printSafe({
        ok: true,
        mode: 'dry-run',
        writeEnabled: false,
        targetTable: OVERTIME_TABLE_ID,
        cards: 'in-memory-only',
        applyCommand: '--apply-real',
      });
      return;
    }
    stage = 'dependencies';
    if (options.mode === 'audit-only') {
      const deps = await createResidualAuditDependencies();
      stage = 'audit';
      printSafe(await auditWorkflowSelfTestRecords(deps));
      return;
    }
    if (options.mode === 'cleanup-only') {
      const deps = await createResidualAuditDependencies({ allowDelete: true });
      stage = 'cleanup';
      printSafe(await cleanupResidualWorkflowSelfTestRecords(deps));
      return;
    }
    const discoveryDeps = await createRealDependencies();
    let selection;
    try {
      selection = await discoveryDeps.discoverMatrixCandidates();
    } finally {
      await discoveryDeps.cleanupLedger();
    }
    const auditDependencies = await createResidualAuditDependencies();
    stage = 'execute-matrix';
    const result = await runOvertimeWorkflowRealMatrixSelfTest(options, {
      ...selection,
      createScenarioDependencies: (candidate) =>
        createRealDependencies({ candidate }),
      audit: () => auditWorkflowSelfTestRecords(auditDependencies),
    });
    printSafe(result);
  } catch (error) {
    printSafe(buildSafeWorkflowSelfTestError(error, stage));
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;

if (isMain) await main();
