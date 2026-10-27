import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
const scriptPath = resolve(root, 'scripts/self-test-overtime-workflow.mjs');
const scriptUrl = pathToFileURL(scriptPath).href;

function source(): string {
  return existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';
}

function runCli(args: string[] = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runScenario(body: string): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import * as subject from ${JSON.stringify(scriptUrl)};\n${body}`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `scenario exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe('overtime workflow real Base self-test', () => {
  it('is dry-run by default and never loads real dependencies or writes Base', () => {
    const result = runCli();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.trim())).toEqual(
      expect.objectContaining({
        ok: true,
        mode: 'dry-run',
        writeEnabled: false,
        cards: 'in-memory-only',
      }),
    );
  });

  it('requires the explicit apply flag and contains no embedded credentials', () => {
    const value = source();

    expect(value).toContain('--apply-real');
    expect(value).toContain("const OVERTIME_TABLE_ID = 'tblpCzmTT3EapaUY'");
    expect(value).toContain('OvertimeWorkflowService');
    expect(value).toContain('OvertimeWorkflowStore');
    expect(value).toContain('fetchOrganizationRoutingRecords');
    expect(value).toContain('getCachedActivePersonnelDirectory');
    expect(value).toContain('application.approvalCards');
    expect(value).toContain('application.confirmationResultCards');
    expect(value).toContain('assertWorkflowCardDeliveryCoverage(application)');
    expect(value).not.toContain("messageId: 'om_selftest_approval_action'");
    expect(value).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(value).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/i);
    expect(value).not.toMatch(
      /(?:app[_-]?secret|tenant[_-]?access[_-]?token|authorization|password)\s*[:=]\s*['"`][A-Za-z0-9._-]{16,}['"`]/i,
    );
  });

  it('exposes separate dry-run and explicit real-write npm commands', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['self-test:overtime-workflow:dry-run']).toBe(
      'node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --dry-run',
    );
    expect(
      packageJson.scripts?.['self-test:overtime-workflow:apply-real'],
    ).toBe(
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --apply-real',
    );
    expect(packageJson.scripts?.['self-test:overtime-workflow:audit']).toBe(
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --audit-only',
    );
    expect(packageJson.scripts?.['self-test:overtime-workflow:cleanup']).toBe(
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-overtime-workflow.mjs --cleanup-only',
    );
  });

  it('selects one real candidate for each available building route without reusing a person', () => {
    const result = runScenario(`
      const personnel = [
        { name: 'A员工', openId: 'ou_staff_a', position: '运维值班员', buildings: ['A楼'] },
        { name: 'B员工', openId: 'ou_staff_b', position: '运维值班员', buildings: ['B楼'] },
        { name: 'H员工', openId: 'ou_staff_h', position: '运维值班员', buildings: ['H楼'] },
        { name: '110员工', openId: 'ou_staff_110', position: '运维值班员', buildings: ['110站'] },
        { name: '主管', openId: 'ou_manager_candidate', position: '楼栋主管', buildings: ['C楼'] },
      ];
      const routes = {
        'ou_staff_a': 'building_supervisor',
        'ou_staff_b': 'building_supervisor',
        'ou_staff_h': 'h_duty_supervisor',
        'ou_staff_110': 'station_110_electrical_supervisor',
        'ou_manager_candidate': 'manager_group',
      };
      const value = subject.selectOvertimeWorkflowMatrixCandidates({
        personnel,
        organizationRecords: [],
        managerRecipients: [{ name: '机房经理', openId: 'ou_manager' }],
        resolveRoute: ({ applicant }) => ({
          kind: routes[applicant.openId],
          approvers: [{ name: '审批人', openId: 'ou_approver' }],
        }),
      });
      process.stdout.write(JSON.stringify(value));
    `);

    expect(
      (result.candidates as Array<Record<string, unknown>>).map(
        (entry) => entry.scenario,
      ),
    ).toEqual([
      'building_a',
      'building_b',
      'h_duty',
      'station_110',
      'manager_group',
    ]);
    expect(
      (result.skipped as Array<Record<string, unknown>>).map(
        (entry) => entry.scenario,
      ),
    ).toEqual(['building_c', 'building_d', 'building_e']);
    expect(
      new Set(
        (result.candidates as Array<Record<string, unknown>>).map(
          (entry) => entry.staffOpenId,
        ),
      ).size,
    ).toBe(5);
    expect(
      (result.candidates as Array<Record<string, unknown>>).map((entry) => ({
        approvers: entry.expectedApproverOpenIds,
        managers: entry.expectedManagerOpenIds,
      })),
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        approvers: ['ou_approver'],
        managers: ['ou_manager'],
      })),
    );
  });

  it('falls back to organization manager records when the cached manager list is empty', () => {
    const result = runScenario(`
      const value = subject.selectOvertimeWorkflowMatrixCandidates({
        personnel: [{ name: 'A员工', openId: 'ou_staff_a', position: '运维值班员', buildings: ['A楼'] }],
        organizationRecords: [{ name: '机房经理', openId: 'ou_manager_fallback', position: '设施运维经理', buildings: [], supervisorNames: [] }],
        managerRecipients: [],
        resolveRoute: () => ({ kind: 'building_supervisor', approvers: [{ name: '审批人', openId: 'ou_approver' }] }),
      });
      process.stdout.write(JSON.stringify(value));
    `);

    expect(result.candidates).toEqual([
      expect.objectContaining({
        scenario: 'building_a',
        expectedApproverOpenIds: ['ou_approver'],
        expectedManagerOpenIds: ['ou_manager_fallback'],
      }),
    ]);
  });

  it('runs at least three different buildings including H or 110 and returns only safe matrix summaries', () => {
    const result = runScenario(`
      const candidates = [
        { scenario: 'building_a', routeKind: 'building_supervisor', staffName: 'A真实姓名', staffOpenId: 'ou_real_a', building: 'A楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager_1', 'ou_manager_2'] },
        { scenario: 'building_b', routeKind: 'building_supervisor', staffName: 'B真实姓名', staffOpenId: 'ou_real_b', building: 'B楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager_1', 'ou_manager_2'] },
        { scenario: 'h_duty', routeKind: 'h_duty_supervisor', staffName: 'H真实姓名', staffOpenId: 'ou_real_h', building: 'H楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager_1', 'ou_manager_2'] },
      ];
      const executed = [];
      const value = await subject.runOvertimeWorkflowRealMatrixSelfTest({}, {
        candidates,
        skipped: [{ scenario: 'station_110', reason: 'NO_MATCHING_ROUTE' }],
        createScenarioDependencies: async (candidate) => ({ candidate }),
        executeScenario: async (scenarioOptions, deps) => {
          executed.push(deps.candidate.scenario);
          const actualHours = scenarioOptions.confirmationActualHours === 0 ? 0 : 1;
          return {
            ok: true, cleaned: true, residualCount: 0,
            approverCount: 1, managerRecipientCount: 2,
            approvalCardCount: 1, managerNoticeCardCount: 3,
            confirmationRecipientCount: 4,
            initialConfirmationCardCount: 1,
            confirmationResultCardCount: 3,
            expectedCardSendCount: 8,
            fakeCardSendCount: 8, fakeCardPatchCount: 2, fakeCardPatchCoverageExact: true,
            fakeCardStageCounts: { approvalCards: 1, managerNoticeCards: 3, confirmationCards: 1, confirmationResultCards: 3 },
            fakeCardPatchStageCounts: { approvalCards: 1, confirmationCards: 1 },
            approverOpenIds: ['ou_approver'], managerRecipientOpenIds: ['ou_manager_1', 'ou_manager_2'],
            workflowState: 'confirmed',
            actualHours,
          };
        },
        audit: async () => ({ ok: true, candidateCount: 0 }),
      });
      process.stdout.write(JSON.stringify({ value, executed }));
    `);

    expect(result.executed).toEqual(['building_a', 'building_b', 'h_duty']);
    expect(result.value).toEqual(
      expect.objectContaining({
        ok: true,
        mode: 'apply-real-matrix',
        scenarioCount: 3,
        distinctBuildingCount: 3,
        residualCount: 0,
      }),
    );
    expect(
      (result.value as { scenarios: Array<Record<string, unknown>> }).scenarios,
    ).toEqual([
      expect.objectContaining({
        scenario: 'building_a',
        route: 'building_supervisor',
        building: 'A楼',
        result: 'confirmed-cleaned',
      }),
      expect.objectContaining({
        scenario: 'building_b',
        route: 'building_supervisor',
        building: 'B楼',
        result: 'confirmed-cleaned',
      }),
      expect.objectContaining({
        scenario: 'h_duty',
        route: 'h_duty_supervisor',
        building: 'H楼',
        result: 'confirmed-cleaned',
      }),
    ]);
    expect(JSON.stringify(result.value)).not.toContain('真实姓名');
    expect(JSON.stringify(result.value)).not.toContain('ou_real_');
  });

  it('accepts manager-group scenarios where existing approval cards replace duplicate manager notices', () => {
    const result = runScenario(`
      const candidates = [
        { scenario: 'building_a', routeKind: 'building_supervisor', staffName: 'A测试', staffOpenId: 'ou_matrix_a', building: 'A楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager_1', 'ou_manager_2'] },
        { scenario: 'h_duty', routeKind: 'h_duty_supervisor', staffName: 'H测试', staffOpenId: 'ou_matrix_h', building: 'H楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager_1', 'ou_manager_2'] },
        { scenario: 'manager_group', routeKind: 'manager_group', staffName: '主管测试', staffOpenId: 'ou_matrix_manager', building: 'C楼', position: '设施运维主管', expectedApproverOpenIds: ['ou_manager_1', 'ou_manager_2'], expectedManagerOpenIds: ['ou_manager_1', 'ou_manager_2'] },
      ];
      const value = await subject.runOvertimeWorkflowRealMatrixSelfTest({}, {
        candidates,
        skipped: [],
        createScenarioDependencies: async (candidate) => ({ candidate }),
        executeScenario: async (scenarioOptions, deps) =>
          deps.candidate.routeKind === 'manager_group'
            ? {
                ok: true, cleaned: true, residualCount: 0,
                approverCount: 2, managerRecipientCount: 2,
                approvalCardCount: 2, managerNoticeCardCount: 1,
                confirmationRecipientCount: 3,
                initialConfirmationCardCount: 1,
                confirmationResultCardCount: 2,
                expectedCardSendCount: 6, fakeCardSendCount: 6,
                fakeCardStageCounts: { approvalCards: 2, managerNoticeCards: 1, confirmationCards: 1, confirmationResultCards: 2 },
                fakeCardPatchCount: 3,
                fakeCardPatchCoverageExact: true,
                fakeCardPatchStageCounts: { approvalCards: 2, confirmationCards: 1 },
                approverOpenIds: ['ou_manager_1', 'ou_manager_2'], managerRecipientOpenIds: ['ou_manager_1', 'ou_manager_2'],
                workflowState: 'confirmed',
                actualHours: scenarioOptions.confirmationActualHours === 0 ? 0 : 1,
              }
            : {
                ok: true, cleaned: true, residualCount: 0,
                approverCount: 1, managerRecipientCount: 2,
                approvalCardCount: 1, managerNoticeCardCount: 3,
                confirmationRecipientCount: 4,
                initialConfirmationCardCount: 1,
                confirmationResultCardCount: 3,
                expectedCardSendCount: 8, fakeCardSendCount: 8,
                fakeCardStageCounts: { approvalCards: 1, managerNoticeCards: 3, confirmationCards: 1, confirmationResultCards: 3 },
                fakeCardPatchCount: 2,
                fakeCardPatchCoverageExact: true,
                fakeCardPatchStageCounts: { approvalCards: 1, confirmationCards: 1 },
                approverOpenIds: ['ou_approver'], managerRecipientOpenIds: ['ou_manager_1', 'ou_manager_2'],
                workflowState: 'confirmed',
                actualHours: scenarioOptions.confirmationActualHours === 0 ? 0 : 1,
              },
        audit: async () => ({ ok: true, candidateCount: 0 }),
      });
      process.stdout.write(JSON.stringify(value));
    `);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        mode: 'apply-real-matrix',
        scenarioCount: 3,
        residualCount: 0,
      }),
    );
  });

  it('always runs the building A matrix scenario with zero actual hours and keeps the others positive', () => {
    const result = runScenario(`
      const candidates = [
        { scenario: 'building_a', routeKind: 'building_supervisor', staffName: 'A测试', staffOpenId: 'ou_zero_a', building: 'A楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager'] },
        { scenario: 'building_b', routeKind: 'building_supervisor', staffName: 'B测试', staffOpenId: 'ou_positive_b', building: 'B楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager'] },
        { scenario: 'h_duty', routeKind: 'h_duty_supervisor', staffName: 'H测试', staffOpenId: 'ou_positive_h', building: 'H楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager'] },
      ];
      const confirmations = [];
      const value = await subject.runOvertimeWorkflowRealMatrixSelfTest({}, {
        candidates,
        skipped: [],
        createScenarioDependencies: async (candidate) => ({ candidate }),
        executeScenario: async (scenarioOptions, deps) => {
          const actualHours = scenarioOptions.confirmationActualHours === 0 ? 0 : 1;
          confirmations.push({ scenario: deps.candidate.scenario, actualHours });
          return {
            ok: true, cleaned: true, residualCount: 0,
            approverCount: 1, managerRecipientCount: 1,
            approvalCardCount: 1, managerNoticeCardCount: 2,
            confirmationRecipientCount: 3,
            initialConfirmationCardCount: 1,
            confirmationResultCardCount: 2,
            expectedCardSendCount: 6, fakeCardSendCount: 6,
            fakeCardStageCounts: { approvalCards: 1, managerNoticeCards: 2, confirmationCards: 1, confirmationResultCards: 2 },
            fakeCardPatchCount: 2,
            fakeCardPatchCoverageExact: true,
            fakeCardPatchStageCounts: { approvalCards: 1, confirmationCards: 1 },
            approverOpenIds: ['ou_approver'], managerRecipientOpenIds: ['ou_manager'],
            workflowState: 'confirmed',
            actualHours,
          };
        },
        audit: async () => ({ ok: true, candidateCount: 0 }),
      });
      process.stdout.write(JSON.stringify({ value, confirmations }));
    `);

    expect(result.confirmations).toEqual([
      { scenario: 'building_a', actualHours: 0 },
      { scenario: 'building_b', actualHours: 1 },
      { scenario: 'h_duty', actualHours: 1 },
    ]);
    expect(result.value).toEqual(
      expect.objectContaining({
        ok: true,
        zeroHoursScenario: 'building_a',
      }),
    );
    expect(
      (result.value as { scenarios: Array<Record<string, unknown>> }).scenarios,
    ).toEqual([
      expect.objectContaining({ scenario: 'building_a', actualHours: 0 }),
      expect.objectContaining({ scenario: 'building_b', actualHours: 1 }),
      expect.objectContaining({ scenario: 'h_duty', actualHours: 1 }),
    ]);
  });

  it('rejects a matrix scenario whose final route recipients differ from discovery', () => {
    const result = runScenario(`
      const candidates = [
        { scenario: 'building_a', routeKind: 'building_supervisor', staffName: 'A测试', staffOpenId: 'ou_a', building: 'A楼', position: '运维值班员', expectedApproverOpenIds: ['ou_expected_a'], expectedManagerOpenIds: ['ou_manager'] },
        { scenario: 'building_b', routeKind: 'building_supervisor', staffName: 'B测试', staffOpenId: 'ou_b', building: 'B楼', position: '运维值班员', expectedApproverOpenIds: ['ou_expected_b'], expectedManagerOpenIds: ['ou_manager'] },
        { scenario: 'h_duty', routeKind: 'h_duty_supervisor', staffName: 'H测试', staffOpenId: 'ou_h', building: 'H楼', position: '运维值班员', expectedApproverOpenIds: ['ou_expected_h'], expectedManagerOpenIds: ['ou_manager'] },
      ];
      let rejected = false;
      try {
        await subject.runOvertimeWorkflowRealMatrixSelfTest({}, {
          candidates,
          skipped: [],
          createScenarioDependencies: async (candidate) => ({ candidate }),
          executeScenario: async (scenarioOptions, deps) => ({
            ok: true, cleaned: true, residualCount: 0,
            approverCount: 1, managerRecipientCount: 1,
            approvalCardCount: 1, managerNoticeCardCount: 2,
            confirmationRecipientCount: 3, initialConfirmationCardCount: 1,
            confirmationResultCardCount: 2, expectedCardSendCount: 6,
            fakeCardSendCount: 6, fakeCardPatchCount: 2, fakeCardPatchCoverageExact: true,
            fakeCardStageCounts: { approvalCards: 1, managerNoticeCards: 2, confirmationCards: 1, confirmationResultCards: 2 },
            fakeCardPatchStageCounts: { approvalCards: 1, confirmationCards: 1 },
            approverOpenIds: deps.candidate.scenario === 'building_b' ? ['ou_wrong'] : deps.candidate.expectedApproverOpenIds,
            managerRecipientOpenIds: deps.candidate.expectedManagerOpenIds,
            workflowState: 'confirmed', actualHours: scenarioOptions.confirmationActualHours === 0 ? 0 : 1,
          }),
          audit: async () => ({ ok: true, candidateCount: 0 }),
        });
      } catch (error) { rejected = error instanceof Error; }
      process.stdout.write(JSON.stringify({ rejected }));
    `);

    expect(result).toEqual({ rejected: true });
  });

  it('counts approval, approval result, initial confirmation and confirmation result sends with Open ID deduplication', () => {
    const result = runScenario(`
      const application = {
        recordId: 'rec1',
        snapshot: { applicantOpenId: 'ou_applicant' },
        approvers: [
          { name: '审批人', openId: 'ou_approver' },
          { name: '兼任经理', openId: 'ou_manager_overlap' },
        ],
        managerRecipients: [
          { name: '兼任经理', openId: 'ou_manager_overlap' },
          { name: '经理', openId: 'ou_manager' },
        ],
        actualApproverOpenId: 'ou_approver',
        approvalCards: [
          { recipientOpenId: 'ou_approver', businessKey: 'overtime:rec1:approval:ou_approver', messageId: 'om_approval' },
          { recipientOpenId: 'ou_manager_overlap', businessKey: 'overtime:rec1:approval:ou_manager_overlap', messageId: 'om_approval_overlap' },
        ],
        managerNoticeCards: [
          { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec1:approval-result:ou_applicant', messageId: 'om_approval_applicant' },
          { recipientOpenId: 'ou_manager', businessKey: 'overtime:rec1:approval-result:ou_manager', messageId: 'om_approval_manager' },
        ],
        confirmationCards: [
          { recipientOpenId: 'ou_approver', businessKey: 'overtime-confirm:rec1:initial', messageId: 'om_initial' },
        ],
        confirmationResultCards: [
          { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec1:confirmation-result:ou_applicant', messageId: 'om_applicant' },
          { recipientOpenId: 'ou_manager_overlap', businessKey: 'overtime:rec1:confirmation-result:ou_manager_overlap', messageId: 'om_overlap' },
          { recipientOpenId: 'ou_manager', businessKey: 'overtime:rec1:confirmation-result:ou_manager', messageId: 'om_manager' },
        ],
      };
      const expectedCardSendCount = subject.expectedWorkflowCardSendCount(application);
      const coverage = subject.assertConfirmationResultDeliveryCoverage(application);
      process.stdout.write(JSON.stringify({ expectedCardSendCount, coverage }));
    `);

    expect(result).toEqual({
      expectedCardSendCount: 8,
      coverage: {
        recipientCount: 4,
        initialConfirmationCardCount: 1,
        confirmationResultCardCount: 3,
      },
    });
  });

  it('deduplicates the applicant, approver and manager when all roles share one Open ID', () => {
    const result = runScenario(`
      const application = {
        recordId: 'rec-overlap',
        snapshot: { applicantOpenId: 'ou_same_person' },
        approvers: [{ name: '同一人', openId: 'ou_same_person' }],
        managerRecipients: [{ name: '同一人', openId: 'ou_same_person' }],
        actualApproverOpenId: 'ou_same_person',
        approvalCards: [
          { recipientOpenId: 'ou_same_person', businessKey: 'overtime:rec-overlap:approval:ou_same_person', messageId: 'om_overlap_approval' },
        ],
        managerNoticeCards: [],
        confirmationCards: [
          { recipientOpenId: 'ou_same_person', businessKey: 'overtime-confirm:rec-overlap:initial', messageId: 'om_overlap_confirmation' },
        ],
        confirmationResultCards: [],
      };
      const coverage = subject.assertWorkflowCardDeliveryCoverage(application);
      process.stdout.write(JSON.stringify(coverage));
    `);

    expect(result).toEqual({
      approvalCardCount: 1,
      managerNoticeCardCount: 0,
      initialConfirmationCardCount: 1,
      confirmationResultCardCount: 0,
      confirmationRecipientCount: 1,
      expectedCardSendCount: 2,
    });
  });

  it('rejects a missing, extra or misrouted delivery in every workflow card stage', () => {
    const result = runScenario(`
      const base = {
        recordId: 'rec-stage',
        snapshot: { applicantOpenId: 'ou_applicant' },
        approvers: [
          { name: '审批人一', openId: 'ou_approver_one' },
          { name: '审批人二', openId: 'ou_approver_two' },
        ],
        managerRecipients: [
          { name: '兼任经理', openId: 'ou_approver_two' },
          { name: '经理', openId: 'ou_manager' },
        ],
        actualApproverOpenId: 'ou_approver_one',
        approvalCards: [
          { recipientOpenId: 'ou_approver_one', businessKey: 'overtime:rec-stage:approval:ou_approver_one', messageId: 'om_approval_one' },
          { recipientOpenId: 'ou_approver_two', businessKey: 'overtime:rec-stage:approval:ou_approver_two', messageId: 'om_approval_two' },
        ],
        managerNoticeCards: [
          { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec-stage:approval-result:ou_applicant', messageId: 'om_approval_applicant' },
          { recipientOpenId: 'ou_manager', businessKey: 'overtime:rec-stage:approval-result:ou_manager', messageId: 'om_approval_manager' },
        ],
        confirmationCards: [
          { recipientOpenId: 'ou_approver_one', businessKey: 'overtime-confirm:rec-stage:initial', messageId: 'om_confirmation' },
        ],
        confirmationResultCards: [
          { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec-stage:confirmation-result:ou_applicant', messageId: 'om_result_applicant' },
          { recipientOpenId: 'ou_approver_two', businessKey: 'overtime:rec-stage:confirmation-result:ou_approver_two', messageId: 'om_result_approver_two' },
          { recipientOpenId: 'ou_manager', businessKey: 'overtime:rec-stage:confirmation-result:ou_manager', messageId: 'om_result_manager' },
        ],
      };
      const cases = [
        ['approval-missing', { approvalCards: base.approvalCards.slice(0, 1) }],
        ['approval-extra', { approvalCards: [...base.approvalCards, { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec-stage:approval:ou_applicant', messageId: 'om_approval_extra' }] }],
        ['approval-result-missing', { managerNoticeCards: base.managerNoticeCards.slice(0, 1) }],
        ['approval-result-extra', { managerNoticeCards: [...base.managerNoticeCards, { recipientOpenId: 'ou_approver_one', businessKey: 'overtime:rec-stage:approval-result:ou_approver_one', messageId: 'om_approval_result_extra' }] }],
        ['confirmation-wrong-recipient', { confirmationCards: [{ recipientOpenId: 'ou_approver_two', businessKey: 'overtime-confirm:rec-stage:initial', messageId: 'om_confirmation_wrong' }] }],
        ['confirmation-extra', { confirmationCards: [...base.confirmationCards, { recipientOpenId: 'ou_approver_one', businessKey: 'overtime:rec-stage:confirmation:repeat', messageId: 'om_confirmation_extra' }] }],
        ['confirmation-result-missing', { confirmationResultCards: base.confirmationResultCards.slice(0, 2) }],
        ['confirmation-result-extra', { confirmationResultCards: [...base.confirmationResultCards, { recipientOpenId: 'ou_intruder', businessKey: 'overtime:rec-stage:confirmation-result:ou_intruder', messageId: 'om_result_extra' }] }],
      ];
      const valid = subject.assertWorkflowCardDeliveryCoverage(base);
      const failures = cases.map(([name, patch]) => {
        try {
          subject.assertWorkflowCardDeliveryCoverage({ ...base, ...patch });
          return { name, rejected: false };
        } catch (error) {
          return { name, rejected: error instanceof Error };
        }
      });
      process.stdout.write(JSON.stringify({ valid, failures }));
    `);

    expect(result.valid).toEqual({
      approvalCardCount: 2,
      managerNoticeCardCount: 2,
      initialConfirmationCardCount: 1,
      confirmationResultCardCount: 3,
      confirmationRecipientCount: 4,
      expectedCardSendCount: 8,
    });
    expect(result.failures).toEqual([
      { name: 'approval-missing', rejected: true },
      { name: 'approval-extra', rejected: true },
      { name: 'approval-result-missing', rejected: true },
      { name: 'approval-result-extra', rejected: true },
      { name: 'confirmation-wrong-recipient', rejected: true },
      { name: 'confirmation-extra', rejected: true },
      { name: 'confirmation-result-missing', rejected: true },
      { name: 'confirmation-result-extra', rejected: true },
    ]);
  });

  it('rejects delivery business keys from another record and the legacy initial-confirmation format', () => {
    const result = runScenario(`
      const base = {
        recordId: 'rec-exact-key',
        snapshot: { applicantOpenId: 'ou_applicant' },
        approvers: [{ name: '审批人', openId: 'ou_approver' }],
        managerRecipients: [{ name: '经理', openId: 'ou_manager' }],
        actualApproverOpenId: 'ou_approver',
        approvalCards: [
          { recipientOpenId: 'ou_approver', businessKey: 'overtime:rec-exact-key:approval:ou_approver', messageId: 'om_approval' },
        ],
        managerNoticeCards: [
          { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec-exact-key:approval-result:ou_applicant', messageId: 'om_approval_applicant' },
          { recipientOpenId: 'ou_manager', businessKey: 'overtime:rec-exact-key:approval-result:ou_manager', messageId: 'om_approval_manager' },
        ],
        confirmationCards: [
          { recipientOpenId: 'ou_approver', businessKey: 'overtime-confirm:rec-exact-key:initial', messageId: 'om_confirmation' },
        ],
        confirmationResultCards: [
          { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec-exact-key:confirmation-result:ou_applicant', messageId: 'om_result_applicant' },
          { recipientOpenId: 'ou_manager', businessKey: 'overtime:rec-exact-key:confirmation-result:ou_manager', messageId: 'om_result_manager' },
        ],
      };
      subject.assertWorkflowCardDeliveryCoverage(base);
      const cases = [
        ['approval-wrong-record', { approvalCards: [{ ...base.approvalCards[0], businessKey: 'overtime:rec-other:approval:ou_approver' }] }],
        ['approval-result-wrong-record', { managerNoticeCards: [{ ...base.managerNoticeCards[0], businessKey: 'overtime:rec-other:approval-result:ou_applicant' }, base.managerNoticeCards[1]] }],
        ['initial-wrong-record', { confirmationCards: [{ ...base.confirmationCards[0], businessKey: 'overtime-confirm:rec-other:initial' }] }],
        ['initial-legacy-format', { confirmationCards: [{ ...base.confirmationCards[0], businessKey: 'overtime:rec-exact-key:confirmation:initial' }] }],
        ['confirmation-result-wrong-record', { confirmationResultCards: [{ ...base.confirmationResultCards[0], businessKey: 'overtime:rec-other:confirmation-result:ou_applicant' }, base.confirmationResultCards[1]] }],
      ];
      const failures = cases.map(([name, patch]) => {
        try {
          subject.assertWorkflowCardDeliveryCoverage({ ...base, ...patch });
          return { name, rejected: false };
        } catch (error) {
          return { name, rejected: error instanceof Error };
        }
      });
      process.stdout.write(JSON.stringify(failures));
    `);

    expect(result).toEqual([
      { name: 'approval-wrong-record', rejected: true },
      { name: 'approval-result-wrong-record', rejected: true },
      { name: 'initial-wrong-record', rejected: true },
      { name: 'initial-legacy-format', rejected: true },
      { name: 'confirmation-result-wrong-record', rejected: true },
    ]);
  });

  it('rejects per-stage fake sends even when their four-stage total is unchanged', () => {
    const result = runScenario(`
      const coverage = {
        approvalCardCount: 2,
        managerNoticeCardCount: 2,
        initialConfirmationCardCount: 1,
        confirmationResultCardCount: 3,
        confirmationRecipientCount: 4,
        expectedCardSendCount: 8,
      };
      const validEvidence = {
        fakeCardSendCount: 8,
        fakeCardStageCounts: {
          approvalCards: 2,
          managerNoticeCards: 2,
          confirmationCards: 1,
          confirmationResultCards: 3,
        },
        fakeCardPatchCount: 3,
        fakeCardPatchCoverageExact: true,
        fakeCardPatchStageCounts: {
          approvalCards: 2,
          confirmationCards: 1,
        },
      };
      subject.assertWorkflowCardSendEvidence(coverage, validEvidence);
      const cases = [
        {
          name: 'approval-shifted-to-approval-result',
          evidence: { ...validEvidence, fakeCardStageCounts: { ...validEvidence.fakeCardStageCounts, approvalCards: 1, managerNoticeCards: 3 } },
        },
        {
          name: 'confirmation-shifted-to-result',
          evidence: { ...validEvidence, fakeCardStageCounts: { ...validEvidence.fakeCardStageCounts, confirmationCards: 0, confirmationResultCards: 4 } },
        },
        {
          name: 'approval-terminal-patch-missing',
          evidence: { ...validEvidence, fakeCardPatchCount: 2, fakeCardPatchStageCounts: { approvalCards: 1, confirmationCards: 1 } },
        },
        {
          name: 'confirmation-terminal-patch-missing',
          evidence: { ...validEvidence, fakeCardPatchCount: 2, fakeCardPatchStageCounts: { approvalCards: 2, confirmationCards: 0 } },
        },
        {
          name: 'one-actionable-card-patched-twice',
          evidence: { ...validEvidence, fakeCardPatchCoverageExact: false },
        },
      ];
      const failures = cases.map(({ name, evidence }) => {
        try {
          subject.assertWorkflowCardSendEvidence(coverage, evidence);
          return { name, rejected: false };
        } catch (error) {
          return { name, rejected: error instanceof Error };
        }
      });
      process.stdout.write(JSON.stringify({ valid: true, failures }));
    `);

    expect(result).toEqual({
      valid: true,
      failures: [
        { name: 'approval-shifted-to-approval-result', rejected: true },
        { name: 'confirmation-shifted-to-result', rejected: true },
        { name: 'approval-terminal-patch-missing', rejected: true },
        { name: 'confirmation-terminal-patch-missing', rejected: true },
        { name: 'one-actionable-card-patched-twice', rejected: true },
      ],
    });
  });

  it('parses patched card JSON and accepts only the matching action-free terminal shape', () => {
    const result = runScenario(`
      const approvalTerminal = {
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: '加班申请审批通过' } },
        body: { elements: [{
          tag: 'column_set',
          columns: ['同意', '驳回'].map((label) => ({
            tag: 'column',
            elements: [{ tag: 'button', type: 'default', disabled: true, text: { tag: 'plain_text', content: label } }],
          })),
        }] },
      };
      const confirmationTerminal = {
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: '加班已取消' } },
        body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '未实际发生' } }] },
      };
      const check = (stage, card) => {
        try {
          subject.assertWorkflowTerminalCardPatch(stage, card);
          return true;
        } catch {
          return false;
        }
      };
      process.stdout.write(JSON.stringify({
        validApproval: check('approvalCards', approvalTerminal),
        validConfirmation: check('confirmationCards', confirmationTerminal),
        enabledApproval: check('approvalCards', {
          ...approvalTerminal,
          body: { elements: [{ tag: 'button', disabled: false, text: { content: '同意' } }] },
        }),
        callbackApproval: check('approvalCards', {
          ...approvalTerminal,
          body: { elements: [{ tag: 'button', disabled: true, text: { content: '同意' }, behaviors: [{ type: 'callback' }] }] },
        }),
        actionBearingApproval: check('approvalCards', {
          ...approvalTerminal,
          actions: [{ type: 'callback' }],
        }),
        actionableConfirmation: check('confirmationCards', {
          ...confirmationTerminal,
          body: { elements: [{ tag: 'button', behaviors: [{ type: 'open_url' }] }] },
        }),
        missingConfirmationBody: check('confirmationCards', {
          ...confirmationTerminal,
          body: undefined,
        }),
        emptyConfirmationBody: check('confirmationCards', {
          ...confirmationTerminal,
          body: { elements: [] },
        }),
        nonDefaultApprovalButtons: check('approvalCards', {
          ...approvalTerminal,
          body: {
            elements: [{
              tag: 'column_set',
              columns: ['同意', '驳回'].map((label) => ({
                tag: 'column',
                elements: [{ tag: 'button', type: 'primary', disabled: true, text: { tag: 'plain_text', content: label } }],
              })),
            }],
          },
        }),
        approvalButtonPayload: check('approvalCards', {
          ...approvalTerminal,
          body: {
            elements: [{
              tag: 'column_set',
              columns: ['同意', '驳回'].map((label) => ({
                tag: 'column',
                elements: [{ tag: 'button', type: 'default', disabled: true, value: { recordId: 'rec_1' }, text: { tag: 'plain_text', content: label } }],
              })),
            }],
          },
        }),
        confirmationForm: check('confirmationCards', {
          ...confirmationTerminal,
          body: { elements: [{ tag: 'form', elements: [] }] },
        }),
        wrongStageTitle: check('confirmationCards', approvalTerminal),
      }));
    `);

    expect(result).toEqual({
      validApproval: true,
      validConfirmation: true,
      enabledApproval: false,
      callbackApproval: false,
      actionBearingApproval: false,
      actionableConfirmation: false,
      missingConfirmationBody: false,
      emptyConfirmationBody: false,
      nonDefaultApprovalButtons: false,
      approvalButtonPayload: false,
      confirmationForm: false,
      wrongStageTitle: false,
    });
  });

  it('requires every actionable card patch to match the original card stage exactly once', () => {
    const result = runScenario(`
      const sent = [
        { messageId: 'om_approval', stage: 'approvalCards' },
        { messageId: 'om_confirmation', stage: 'confirmationCards' },
      ];
      const valid = subject.hasExactActionableCardPatchCoverage({
        sent,
        patched: [
          { messageId: 'om_approval', stage: 'approvalCards', terminalValid: true },
          { messageId: 'om_confirmation', stage: 'confirmationCards', terminalValid: true },
        ],
      });
      const swappedStages = subject.hasExactActionableCardPatchCoverage({
        sent,
        patched: [
          { messageId: 'om_approval', stage: 'confirmationCards', terminalValid: true },
          { messageId: 'om_confirmation', stage: 'approvalCards', terminalValid: true },
        ],
      });
      process.stdout.write(JSON.stringify({ valid, swappedStages }));
    `);

    expect(result).toEqual({ valid: true, swappedStages: false });
  });

  it('rejects missing or duplicate confirmation result recipients', () => {
    const result = runScenario(`
      const base = {
        recordId: 'rec2',
        snapshot: { applicantOpenId: 'ou_applicant' },
        approvers: [{ name: '审批人', openId: 'ou_approver' }],
        managerRecipients: [{ name: '经理', openId: 'ou_manager' }],
        actualApproverOpenId: 'ou_approver',
        approvalCards: [
          { recipientOpenId: 'ou_approver', businessKey: 'overtime:rec2:approval:ou_approver', messageId: 'om_approval' },
        ],
        managerNoticeCards: [
          { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec2:approval-result:ou_applicant', messageId: 'om_approval_applicant' },
          { recipientOpenId: 'ou_manager', businessKey: 'overtime:rec2:approval-result:ou_manager', messageId: 'om_approval_manager' },
        ],
        confirmationCards: [
          { recipientOpenId: 'ou_approver', businessKey: 'overtime-confirm:rec2:initial', messageId: 'om_initial' },
        ],
      };
      const cases = [
        {
          name: 'missing-manager',
          application: {
            ...base,
            confirmationResultCards: [
              { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec2:confirmation-result:ou_applicant', messageId: 'om_applicant' },
            ],
          },
        },
        {
          name: 'duplicate-applicant',
          application: {
            ...base,
            confirmationResultCards: [
              { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec2:confirmation-result:ou_applicant', messageId: 'om_applicant_1' },
              { recipientOpenId: 'ou_applicant', businessKey: 'overtime:rec2:confirmation-result:ou_applicant', messageId: 'om_applicant_2' },
              { recipientOpenId: 'ou_manager', businessKey: 'overtime:rec2:confirmation-result:ou_manager', messageId: 'om_manager' },
            ],
          },
        },
      ];
      const failures = cases.map(({ name, application }) => {
        try {
          subject.assertConfirmationResultDeliveryCoverage(application);
          return { name, rejected: false };
        } catch (error) {
          return { name, rejected: error instanceof Error };
        }
      });
      process.stdout.write(JSON.stringify({ failures }));
    `);

    expect(result.failures).toEqual([
      { name: 'missing-manager', rejected: true },
      { name: 'duplicate-applicant', rejected: true },
    ]);
  });

  it('stops the matrix after a cleanup failure and always audits residual records', () => {
    const result = runScenario(`
      const candidates = [
        { scenario: 'building_a', routeKind: 'building_supervisor', staffName: 'A员工', staffOpenId: 'ou_a', building: 'A楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager'] },
        { scenario: 'building_b', routeKind: 'building_supervisor', staffName: 'B员工', staffOpenId: 'ou_b', building: 'B楼', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager'] },
        { scenario: 'station_110', routeKind: 'station_110_electrical_supervisor', staffName: '110员工', staffOpenId: 'ou_110', building: '110站', position: '运维值班员', expectedApproverOpenIds: ['ou_approver'], expectedManagerOpenIds: ['ou_manager'] },
      ];
      const executed = [];
      let auditCalls = 0;
      let safe = null;
      try {
        await subject.runOvertimeWorkflowRealMatrixSelfTest({}, {
          candidates,
          skipped: [],
          createScenarioDependencies: async (candidate) => ({ candidate }),
          executeScenario: async (_options, deps) => {
            executed.push(deps.candidate.scenario);
            throw new Error('CLEANUP_FAILED: token=secret');
          },
          audit: async () => { auditCalls += 1; return { ok: true, candidateCount: 1 }; },
        });
      } catch (error) {
        safe = { name: error.name, message: String(error.message).includes('token=secret') };
      }
      process.stdout.write(JSON.stringify({ executed, auditCalls, safe }));
    `);

    expect(result.executed).toEqual(['building_a']);
    expect(result.auditCalls).toBe(1);
    expect(result.safe).toEqual({ name: 'AggregateError', message: false });
  });

  it('uses a fresh clock after each durable enqueue before scanning tasks', () => {
    const result = runScenario(`
      let tick = 0;
      let phase = 'none';
      const runTimes = [];
      const fields = {};
      const record = { record_id: 'recFreshClock', fields };
      const deps = {
        now: () => new Date(Date.parse('2026-08-12T12:00:00.000Z') + tick++ * 1000),
        randomUUID: () => '44444444-4444-4444-8444-444444444444',
        selectCandidate: async (range) => ({ staffName: '张三', staffOpenId: 'ou_applicant', building: 'A楼', position: '运维值班员', ...range, plannedHours: 1 }),
        createBaseRecord: async ({ identity }) => { Object.assign(fields, { '请求唯一ID': identity.requestUniqueId, '加班原因': identity.marker, '请求指纹': identity.fingerprint }); return record.record_id; },
        acceptApplication: async () => { phase = 'pending_approval'; },
        runPendingTasks: async (runAt) => { runTimes.push(runAt.toISOString()); if (phase === 'pending_approval') phase = 'approval_pending'; else if (phase === 'approval_claimed') phase = 'awaiting_confirmation'; else if (phase === 'reminder') phase = 'confirmation_sent'; else if (phase === 'confirmation') phase = 'confirmed'; },
        getApplication: async () => ({
          recordId: 'recFreshClock',
          phase: phase === 'confirmation_sent' ? 'awaiting_confirmation' : phase,
          snapshot: { applicantOpenId: 'ou_applicant' },
          approvers: [{ name: '审批人', openId: 'ou_approver' }],
          managerRecipients: [{ name: '经理', openId: 'ou_manager' }],
          actualApproverOpenId: phase === 'approval_pending' ? '' : 'ou_approver',
          approvalCards: [
            { recipientOpenId: 'ou_approver', businessKey: 'overtime:recFreshClock:approval:ou_approver', messageId: 'om_approval' },
          ],
          managerNoticeCards: [
            { recipientOpenId: 'ou_applicant', businessKey: 'overtime:recFreshClock:approval-result:ou_applicant', messageId: 'om_approval_applicant' },
            { recipientOpenId: 'ou_manager', businessKey: 'overtime:recFreshClock:approval-result:ou_manager', messageId: 'om_approval_manager' },
          ],
          confirmationCards: phase === 'approval_pending' ? [] : [
            { recipientOpenId: 'ou_approver', businessKey: 'overtime-confirm:recFreshClock:initial', messageId: 'om_initial' },
          ],
          confirmationResultCards: phase === 'confirmed' ? [
            { recipientOpenId: 'ou_applicant', businessKey: 'overtime:recFreshClock:confirmation-result:ou_applicant', messageId: 'om_applicant' },
            { recipientOpenId: 'ou_manager', businessKey: 'overtime:recFreshClock:confirmation-result:ou_manager', messageId: 'om_manager' },
          ] : [],
        }),
        acceptApproval: async () => { phase = 'approval_claimed'; },
        enqueueDueConfirmationReminders: async () => { phase = 'reminder'; return 1; },
        submitConfirmation: async () => { phase = 'confirmation'; },
        readBaseRecord: async () => { if (phase === 'confirmed') Object.assign(fields, { '加班工作流状态': '已确认', '加班审批': '同意', '加班流程进展': '已确认', '审批进度': '审批结束', '加班审批人': [{id:'ou_approver'}], '加班审批时间': 1, '加班经理知会时间': 1, '实际加班开始时间': Date.parse('2026-08-12T18:00:00+08:00'), '实际加班结束时间': Date.parse('2026-08-12T19:00:00+08:00'), '实际加班时长': 1, '确认加班工时': 1, '加班工时处置': '调休', '加班确认': '确认', '加班确认人': [{id:'ou_approver'}], '加班确认时间': 1, '加班工作流错误': '' }); return record; },
        queryBaseByUniqueId: async () => phase === 'deleted' ? [] : [record],
        deleteBaseRecord: async () => { phase = 'deleted'; },
        cleanupLedger: async () => undefined,
      };
      await subject.runOvertimeWorkflowRealSelfTest({}, deps);
      process.stdout.write(JSON.stringify({ runTimes }));
    `);

    expect(result.runTimes).toEqual([
      '2026-08-12T12:00:01.000Z',
      '2026-08-12T12:00:02.000Z',
      '2026-08-12T12:00:03.000Z',
      '2026-08-12T12:00:04.000Z',
    ]);
  });

  it('returns safe phase and field diagnostics without exposing raw values', () => {
    const result = runScenario(`
      const deps = {
        now: () => new Date('2026-08-12T12:00:00.000Z'),
        randomUUID: () => '55555555-5555-4555-8555-555555555555',
        selectCandidate: async () => { throw new Error('token=very-secret candidate failed'); },
        createBaseRecord: async () => '', acceptApplication: async () => undefined,
        runPendingTasks: async () => undefined, getApplication: async () => null,
        acceptApproval: async () => undefined, enqueueDueConfirmationReminders: async () => 0,
        submitConfirmation: async () => undefined, readBaseRecord: async () => null,
        queryBaseByUniqueId: async () => [], deleteBaseRecord: async () => undefined,
        cleanupLedger: async () => undefined,
      };
      try { await subject.runOvertimeWorkflowRealSelfTest({}, deps); }
      catch (error) { process.stdout.write(JSON.stringify(subject.buildSafeWorkflowSelfTestError(error))); }
    `);

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'CANDIDATE_ROUTE_FAILED',
        phase: 'candidate-route',
      }),
    );
    expect(JSON.stringify(result)).not.toContain('very-secret');

    const fieldDiagnostics = runScenario(`
      const startAt = '2026-08-12T18:00:00+08:00';
      const startMs = Date.parse(startAt);
      const expected = { approverOpenId: 'ou_expected', actualHours: 1, actualStartAt: startAt };
      const validFields = {
        '加班工作流状态': '已确认', '加班审批': '同意',
        '加班流程进展': '已确认', '审批进度': '审批中',
        '加班工时处置': '调休', '加班确认': '确认',
        '加班审批时间': 1, '加班经理知会时间': 1, '加班确认时间': 1,
        '加班审批人': [{ id: 'ou_expected' }], '加班确认人': [{ id: 'ou_expected' }],
        '实际加班开始时间': startMs, '实际加班结束时间': startMs + 60 * 60 * 1000,
        '实际加班时长': 1, '确认加班工时': 1, '加班工作流错误': '',
      };
      const cases = [
        ['加班工作流状态', '待确认', 'WORKFLOW_STATE_MISMATCH'],
        ['加班审批', '驳回', 'APPROVAL_DECISION_MISMATCH'],
        ['加班流程进展', '已审批', 'WORKFLOW_PROGRESS_MISMATCH'],
        ['加班工时处置', '费用结算', 'DISPOSITION_MISMATCH'],
        ['加班确认', '需修改', 'CONFIRMATION_STATE_MISMATCH'],
        ['加班审批时间', 'token=approval-secret', 'APPROVAL_TIME_INVALID'],
        ['加班经理知会时间', 'token=manager-secret', 'MANAGER_NOTICE_TIME_INVALID'],
        ['加班确认时间', 'token=confirmation-secret', 'CONFIRMATION_TIME_INVALID'],
        ['加班审批人', [{ id: 'ou_approval_secret' }], 'APPROVER_IDENTITY_MISMATCH'],
        ['加班确认人', [{ id: 'ou_confirmation_secret' }], 'CONFIRMER_IDENTITY_MISMATCH'],
        ['实际加班开始时间', startMs + 60 * 60 * 1000, 'ACTUAL_START_MISMATCH'],
        ['实际加班结束时间', startMs + 2 * 60 * 60 * 1000, 'ACTUAL_END_MISMATCH'],
        ['实际加班时长', 2, 'ACTUAL_HOURS_MISMATCH'],
        ['确认加班工时', 2, 'CONFIRMED_HOURS_MISMATCH'],
        ['加班工作流错误', 'Bearer workflow-secret-token', 'WORKFLOW_ERROR_NOT_EMPTY'],
      ];
      subject.assertConfirmedWorkflowFields({ record_id: 'recValid', fields: validFields }, expected);
      const diagnostics = [];
      for (const [field, value, assertionCode] of cases) {
        const fields = { ...validFields, [field]: value };
        try {
          subject.assertConfirmedWorkflowFields({ record_id: 'recMismatch', fields }, expected);
        } catch (error) {
          diagnostics.push({ assertionCode, safe: subject.buildSafeWorkflowSelfTestError(error) });
        }
      }
      process.stdout.write(JSON.stringify({ diagnostics }));
    `);

    expect(fieldDiagnostics.diagnostics).toHaveLength(15);
    for (const entry of fieldDiagnostics.diagnostics as Array<{
      assertionCode: string;
      safe: Record<string, unknown>;
    }>) {
      expect(entry.safe).toEqual(
        expect.objectContaining({
          assertionCode: entry.assertionCode,
          field: expect.any(String),
          expectedType: expect.any(String),
          expectedValueCategory: expect.any(String),
          actualType: expect.any(String),
          actualValue: expect.any(String),
        }),
      );
    }
    const serialized = JSON.stringify(fieldDiagnostics);
    expect(serialized).not.toContain('approval-secret');
    expect(serialized).not.toContain('manager-secret');
    expect(serialized).not.toContain('confirmation-secret');
    expect(serialized).not.toContain('workflow-secret-token');
  });

  it('accepts a confirmed zero-hour Base record only when end equals start and disposition is cleared', () => {
    const result = runScenario(`
      const startAt = '2026-08-12T18:00:00+08:00';
      const startMs = Date.parse(startAt);
      const validFields = {
        '加班工作流状态': '已确认', '加班审批': '同意',
        '加班流程进展': '已确认', '审批进度': '审批结束',
        '加班审批时间': 1, '加班经理知会时间': 1, '加班确认时间': 1,
        '加班审批人': [{ id: 'ou_expected' }], '加班确认人': [{ id: 'ou_expected' }],
        '实际加班开始时间': startMs, '实际加班结束时间': startMs,
        '实际加班时长': 0, '确认加班工时': 0, '加班工时处置': null,
        '加班确认': '确认', '加班工作流错误': '',
      };
      const expected = { approverOpenId: 'ou_expected', actualHours: 0, actualStartAt: startAt };
      subject.assertConfirmedWorkflowFields({ record_id: 'rec-zero', fields: validFields }, expected);
      const cases = [
        ['end-after-start', { '实际加班结束时间': startMs + 60 * 60 * 1000 }],
        ['actual-hours-nonzero', { '实际加班时长': 1 }],
        ['actual-hours-missing', { '实际加班时长': null }],
        ['confirmed-hours-nonzero', { '确认加班工时': 1 }],
        ['confirmed-hours-missing', { '确认加班工时': null }],
        ['actual-hours-string-zero', { '实际加班时长': '0' }],
        ['confirmed-hours-string-zero', { '确认加班工时': '0' }],
        ['actual-hours-boolean-zero', { '实际加班时长': false }],
        ['confirmed-hours-boolean-zero', { '确认加班工时': false }],
        ['actual-hours-array-zero', { '实际加班时长': [0] }],
        ['confirmed-hours-array-zero', { '确认加班工时': [0] }],
        ['disposition-not-cleared', { '加班工时处置': '调休' }],
      ];
      const failures = cases.map(([name, patch]) => {
        try {
          subject.assertConfirmedWorkflowFields(
            { record_id: 'rec-zero-invalid', fields: { ...validFields, ...patch } },
            expected,
          );
          return { name, rejected: false };
        } catch (error) {
          return { name, rejected: error instanceof Error };
        }
      });
      process.stdout.write(JSON.stringify({ valid: true, failures }));
    `);

    expect(result).toEqual({
      valid: true,
      failures: [
        { name: 'end-after-start', rejected: true },
        { name: 'actual-hours-nonzero', rejected: true },
        { name: 'actual-hours-missing', rejected: true },
        { name: 'confirmed-hours-nonzero', rejected: true },
        { name: 'confirmed-hours-missing', rejected: true },
        { name: 'actual-hours-string-zero', rejected: true },
        { name: 'confirmed-hours-string-zero', rejected: true },
        { name: 'actual-hours-boolean-zero', rejected: true },
        { name: 'confirmed-hours-boolean-zero', rejected: true },
        { name: 'actual-hours-array-zero', rejected: true },
        { name: 'confirmed-hours-array-zero', rejected: true },
        { name: 'disposition-not-cleared', rejected: true },
      ],
    });
  });

  it('normalizes only canonical integer strings from verified Feishu Number fields', () => {
    const result = runScenario(`
      const schemas = [
        { fieldName: '实际加班时长', type: 2, uiType: 'Number' },
        { fieldName: '确认加班工时', type: 2, uiType: 'Number' },
      ];
      const valid = subject.normalizeVerifiedOvertimeNumberFields(
        {
          record_id: 'rec-number-transport',
          fields: { '实际加班时长': '0', '确认加班工时': '2', untouched: '2' },
        },
        schemas,
      );
      const invalidCases = [
        ['missing-schema', [], { '实际加班时长': '0', '确认加班工时': '0' }],
        ['wrong-schema-type', [
          { fieldName: '实际加班时长', type: 1, uiType: 'Text' },
          { fieldName: '确认加班工时', type: 2, uiType: 'Number' },
        ], { '实际加班时长': '0', '确认加班工时': '0' }],
        ['leading-zero', schemas, { '实际加班时长': '00', '确认加班工时': '0' }],
        ['decimal', schemas, { '实际加班时长': '1.0', '确认加班工时': '1' }],
        ['array', schemas, { '实际加班时长': [0], '确认加班工时': '0' }],
        ['boolean', schemas, { '实际加班时长': false, '确认加班工时': '0' }],
        ['out-of-range', schemas, { '实际加班时长': '73', '确认加班工时': '0' }],
      ];
      const rejected = invalidCases.map(([name, candidateSchemas, fields]) => {
        try {
          subject.normalizeVerifiedOvertimeNumberFields(
            { record_id: 'rec-invalid', fields },
            candidateSchemas,
          );
          return { name, rejected: false };
        } catch (error) {
          return { name, rejected: error instanceof Error };
        }
      });
      process.stdout.write(JSON.stringify({ valid, rejected }));
    `);

    expect(result.valid).toEqual({
      record_id: 'rec-number-transport',
      fields: { 实际加班时长: 0, 确认加班工时: 2, untouched: '2' },
    });
    expect(result.rejected).toEqual([
      { name: 'missing-schema', rejected: true },
      { name: 'wrong-schema-type', rejected: true },
      { name: 'leading-zero', rejected: true },
      { name: 'decimal', rejected: true },
      { name: 'array', rejected: true },
      { name: 'boolean', rejected: true },
      { name: 'out-of-range', rejected: true },
    ]);
  });

  it('audits valid and malformed residual identities without deleting', () => {
    const result = runScenario(`
      const valid = subject.createWorkflowSelfTestIdentity(new Date('2026-08-12T12:00:00.000Z'), '66666666-6666-4666-8666-666666666666');
      const records = [
        { record_id: 'recValidResidual', fields: { '请求唯一ID': valid.requestUniqueId, '加班原因': valid.marker, '请求指纹': valid.fingerprint } },
        { record_id: 'recMalformedResidual', fields: { '请求唯一ID': 'overtime-workflow-selftest-invalid', '加班原因': 'CODEX-SELFTEST-OVERTIME-WORKFLOW-invalid', '请求指纹': 'x' } },
      ];
      let deletes = 0;
      const value = await subject.auditWorkflowSelfTestRecords({ listWorkflowSelfTestRecords: async () => records, deleteBaseRecord: async () => { deletes += 1; } });
      process.stdout.write(JSON.stringify({ value, deletes }));
    `);

    expect(result.value).toEqual(
      expect.objectContaining({
        mode: 'audit-only',
        candidateCount: 2,
        validIdentityCount: 1,
        invalidIdentityCount: 1,
      }),
    );
    expect(result.deletes).toBe(0);
    expect(JSON.stringify(result.value)).not.toContain(
      'overtime-workflow-selftest-',
    );
  });

  it('cleanup-only deletes exact valid residuals but refuses malformed candidates', () => {
    const result = runScenario(`
      const valid = subject.createWorkflowSelfTestIdentity(new Date('2026-08-12T12:00:00.000Z'), '77777777-7777-4777-8777-777777777777');
      const validRecord = { record_id: 'recValidCleanup', fields: { '请求唯一ID': valid.requestUniqueId, '加班原因': valid.marker, '请求指纹': valid.fingerprint } };
      let records = [validRecord];
      const deps = {
        listWorkflowSelfTestRecords: async () => records,
        queryBaseByUniqueId: async () => records,
        readBaseRecord: async () => validRecord,
        deleteBaseRecord: async () => { records = []; },
      };
      const cleaned = await subject.cleanupResidualWorkflowSelfTestRecords(deps);
      const malformed = { record_id: 'recMalformedCleanup', fields: { '请求唯一ID': 'overtime-workflow-selftest-invalid', '加班原因': 'CODEX-SELFTEST-OVERTIME-WORKFLOW-invalid', '请求指纹': 'x' } };
      records = [malformed];
      let refused = null;
      try { await subject.cleanupResidualWorkflowSelfTestRecords(deps); }
      catch (error) { refused = error.name; }
      process.stdout.write(JSON.stringify({ cleaned, refused, residual: records.length }));
    `);

    expect(result.cleaned).toEqual(
      expect.objectContaining({ deletedCount: 1, residualCount: 0 }),
    );
    expect(result.refused).toBe('UnsafeOvertimeWorkflowCleanupError');
    expect(result.residual).toBe(1);
  });

  it('drives a zero-hour route, approval, due confirmation and exact cleanup', () => {
    const result = runScenario(`
      const events = [];
      let phase = 'none';
      let confirmationInput = null;
      const identityFields = {};
      const record = { record_id: 'recWorkflowSelfTest', fields: identityFields };
      const deps = {
        now: () => new Date('2026-08-12T12:00:00.000Z'),
        randomUUID: () => '11111111-1111-4111-8111-111111111111',
        selectCandidate: async ({ plannedStartAt, plannedEndAt }) => ({
          staffName: '张三', staffOpenId: 'ou_applicant', building: 'A楼',
          position: '运维值班员', plannedStartAt, plannedEndAt,
          plannedHours: 1,
        }),
        createBaseRecord: async ({ identity }) => {
          Object.assign(identityFields, {
            '请求唯一ID': identity.requestUniqueId,
            '加班原因': identity.marker,
            '请求指纹': identity.fingerprint,
          });
          events.push('create');
          return record.record_id;
        },
        acceptApplication: async () => { events.push('accept'); phase = 'pending_approval'; },
        runPendingTasks: async () => {
          if (phase === 'pending_approval') phase = 'approval_pending';
          else if (phase === 'approval_claimed') phase = 'awaiting_confirmation';
          else if (phase === 'reminder_enqueued') phase = 'confirmation_sent';
          else if (phase === 'confirmation_claimed') phase = 'confirmed';
          events.push('run:' + phase);
        },
        getApplication: async () => ({
          recordId: 'recWorkflowSelfTest',
          phase: phase === 'confirmation_sent' ? 'awaiting_confirmation' : phase,
          snapshot: { applicantOpenId: 'ou_applicant' },
          approvers: [{ name: '审批人', openId: 'ou_approver' }],
          managerRecipients: [{ name: '经理', openId: 'ou_manager' }],
          actualApproverOpenId: phase === 'approval_pending' ? '' : 'ou_approver',
          approvalCards: [
            { recipientOpenId: 'ou_approver', businessKey: 'overtime:recWorkflowSelfTest:approval:ou_approver', messageId: 'om_approval' },
          ],
          managerNoticeCards: [
            { recipientOpenId: 'ou_applicant', businessKey: 'overtime:recWorkflowSelfTest:approval-result:ou_applicant', messageId: 'om_approval_applicant' },
            { recipientOpenId: 'ou_manager', businessKey: 'overtime:recWorkflowSelfTest:approval-result:ou_manager', messageId: 'om_approval_manager' },
          ],
          confirmationCards: phase === 'approval_pending' ? [] : [
            { recipientOpenId: 'ou_approver', businessKey: 'overtime-confirm:recWorkflowSelfTest:initial', messageId: 'om_initial' },
          ],
          confirmationResultCards: phase === 'confirmed' ? [
            { recipientOpenId: 'ou_applicant', businessKey: 'overtime:recWorkflowSelfTest:confirmation-result:ou_applicant', messageId: 'om_applicant' },
            { recipientOpenId: 'ou_manager', businessKey: 'overtime:recWorkflowSelfTest:confirmation-result:ou_manager', messageId: 'om_manager' },
          ] : [],
        }),
        acceptApproval: async () => { events.push('approve'); phase = 'approval_claimed'; },
        enqueueDueConfirmationReminders: async () => { events.push('remind'); phase = 'reminder_enqueued'; return 1; },
        submitConfirmation: async (input) => { confirmationInput = input; events.push('confirm'); phase = 'confirmation_claimed'; },
        readBaseRecord: async () => {
          if (phase === 'confirmed') Object.assign(identityFields, {
            '加班工作流状态': '已确认', '加班审批': '同意',
            '加班流程进展': '已确认', '审批进度': '审批中',
            '加班审批人': [{ id: 'ou_approver' }], '加班审批时间': 1786536000000,
            '加班经理知会时间': 1786536000000,
            '实际加班开始时间': 1786528800000,
            '实际加班结束时间': 1786528800000,
            '实际加班时长': 0, '确认加班工时': 0,
            '加班工时处置': null, '加班确认': '确认',
            '加班确认人': [{ id: 'ou_approver' }], '加班确认时间': 1786536000000,
            '加班工作流错误': '',
          });
          return record;
        },
        queryBaseByUniqueId: async () => phase === 'deleted' ? [] : [record],
        deleteBaseRecord: async (recordId) => { events.push('delete:' + recordId); phase = 'deleted'; },
        cleanupLedger: async () => { events.push('ledger-clean'); },
        evidence: () => ({
          fakeCardSendCount: 6,
          fakeCardStageCounts: {
            approvalCards: 1,
            managerNoticeCards: 2,
            confirmationCards: 1,
            confirmationResultCards: 2,
          },
          fakeCardPatchCount: 2,
          fakeCardPatchCoverageExact: true,
          fakeCardPatchStageCounts: {
            approvalCards: 1,
            confirmationCards: 1,
          },
        }),
      };
      const value = await subject.runOvertimeWorkflowRealSelfTest(
        { confirmationActualHours: 0 },
        deps,
      );
      process.stdout.write(JSON.stringify({ value, events, confirmationInput }));
    `);

    expect(result.value).toEqual(
      expect.objectContaining({
        ok: true,
        cleaned: true,
        residualCount: 0,
        approverCount: 1,
        managerRecipientCount: 1,
        confirmationRecipientCount: 3,
        initialConfirmationCardCount: 1,
        confirmationResultCardCount: 2,
        expectedCardSendCount: 6,
        fakeCardSendCount: 6,
        actualHours: 0,
      }),
    );
    expect(result.confirmationInput).toEqual(
      expect.objectContaining({
        actualHours: 0,
        disposition: null,
        actualStartAt: '2026-08-12T18:00:00+08:00',
      }),
    );
    expect(result.events).toEqual([
      'create',
      'accept',
      'run:approval_pending',
      'approve',
      'run:awaiting_confirmation',
      'remind',
      'run:confirmation_sent',
      'confirm',
      'run:confirmed',
      'delete:recWorkflowSelfTest',
      'ledger-clean',
    ]);
  });

  it('cleans the exact test record and temporary ledger when workflow execution fails', () => {
    const result = runScenario(`
      const events = [];
      let deleted = false;
      const identityFields = {};
      const record = { record_id: 'recFailedSelfTest', fields: identityFields };
      const deps = {
        now: () => new Date('2026-08-12T12:00:00.000Z'),
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
        selectCandidate: async (range) => ({ staffName: '张三', staffOpenId: 'ou_applicant', building: 'A楼', position: '运维值班员', ...range, plannedHours: 1 }),
        createBaseRecord: async ({ identity }) => { Object.assign(identityFields, { '请求唯一ID': identity.requestUniqueId, '加班原因': identity.marker, '请求指纹': identity.fingerprint }); return record.record_id; },
        acceptApplication: async () => undefined,
        runPendingTasks: async () => { throw new Error('Bearer top-secret-token'); },
        getApplication: async () => null,
        acceptApproval: async () => undefined,
        enqueueDueConfirmationReminders: async () => 0,
        submitConfirmation: async () => undefined,
        queryBaseByUniqueId: async () => deleted ? [] : [record],
        readBaseRecord: async () => record,
        deleteBaseRecord: async () => { events.push('delete'); deleted = true; },
        cleanupLedger: async () => { events.push('ledger-clean'); },
      };
      try {
        await subject.runOvertimeWorkflowRealSelfTest({}, deps);
      } catch (error) {
        process.stdout.write(JSON.stringify({ safe: subject.buildSafeWorkflowSelfTestError(error), events }));
      }
    `);

    expect(result.events).toEqual(['delete', 'ledger-clean']);
    expect(result.safe).toEqual(
      expect.objectContaining({
        code: 'APPROVAL_ROUTE_FAILED',
        phase: 'route-delivery',
      }),
    );
    expect(JSON.stringify(result.safe)).not.toContain('top-secret-token');
  });

  it('refuses deletion when the exact three-field identity does not match', () => {
    const result = runScenario(`
      const events = [];
      const identity = subject.createWorkflowSelfTestIdentity(
        new Date('2026-08-12T12:00:00.000Z'),
        '33333333-3333-4333-8333-333333333333',
      );
      const record = { record_id: 'recWrongIdentity', fields: {
        '请求唯一ID': identity.requestUniqueId,
        '加班原因': identity.marker + '-tampered',
        '请求指纹': identity.fingerprint,
      }};
      try {
        await subject.cleanupWorkflowSelfTestRecord(identity, record.record_id, {
          queryBaseByUniqueId: async () => [record],
          readBaseRecord: async () => record,
          deleteBaseRecord: async () => events.push('delete'),
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({ name: error.name, events }));
      }
    `);

    expect(result).toEqual({
      name: 'UnsafeOvertimeWorkflowCleanupError',
      events: [],
    });
  });
});
