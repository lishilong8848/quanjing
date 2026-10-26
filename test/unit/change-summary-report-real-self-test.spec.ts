import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
const scriptPath = resolve(root, 'scripts/self-test-change-summary-report.mjs');
const dutyScheduleServicePath = resolve(
  root,
  'server/modules/duty-schedule/duty-schedule.service.ts',
);
const scriptUrl = pathToFileURL(scriptPath).href;

function runScenario(source: string): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import * as subject from ${JSON.stringify(scriptUrl)};\n${source}`,
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
      `self-test scenario exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function source(): string {
  return readFileSync(scriptPath, 'utf8');
}

function dutyScheduleServiceSource(): string {
  return readFileSync(dutyScheduleServicePath, 'utf8');
}

const validStateSource = `({
  version: 1,
  createMutationId: 'change-request-11111111-1111-4111-8111-111111111111',
  cleanupAdjustmentMutationId: 'change-adjustment-22222222-2222-4222-8222-222222222222',
  summaryMutationId: 'change-summary-report-33333333-3333-4333-8333-333333333333',
  changeRecordId: 'recChangeSummary',
  summaryReportRecordId: 'recSummaryReport',
  marker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786400000000-a1b2c3d4',
  cleanupReasonMarker: 'CODEX-SELFTEST-CHANGE-ADJUST-1786400000000-b2c3d4e5',
  summaryFingerprint: 'f'.repeat(64),
  disposition: 'summary-confirmed',
  cleanupPhase: 'none',
  attachments: [
    { id: 'ChangeStorage_123', ownerMutationId: 'change-request-11111111-1111-4111-8111-111111111111', kind: 'change' },
    { id: 'SummaryStorage_456', ownerMutationId: 'change-summary-report-33333333-3333-4333-8333-333333333333', kind: 'summary' },
  ],
})`;

describe('change summary report real-data self-test', () => {
  it('keeps the bound change-attachment cleanup marker contract aligned with summary self-tests', () => {
    const match = dutyScheduleServiceSource().match(
      /const CHANGE_SELF_TEST_SUMMARY_PATTERN\s*=\s*\/(\^[^/\r\n]+)\//,
    );
    expect(match).not.toBeNull();

    const markerPattern = new RegExp(match?.[1] || 'a^');
    expect(
      markerPattern.test(
        'CODEX-SELFTEST-CHANGE-SUMMARY-1786400000000-a1b2c3d4',
      ),
    ).toBe(true);
    expect(
      markerPattern.test('CODEX-SELFTEST-CHANGE-1786400000000-a1b2c3d4'),
    ).toBe(true);
    expect(
      markerPattern.test(
        'CODEX-SELFTEST-CHANGE-SUMMARY-1786400000000-a1b2c3d4-extra',
      ),
    ).toBe(false);
  });

  it('targets only the formal APIs and fixed main/closing tables without embedded credentials', () => {
    const value = source();

    expect(value).toContain("const CHANGE_TABLE_ID = 'tbl8f743982e48e1'");
    expect(value).toContain(
      "const CHANGE_SUMMARY_REPORT_TABLE_ID = 'tbl73b701bc3e2a1'",
    );
    expect(value).toContain('/api/duty-schedules/change-request');
    expect(value).toContain('/api/duty-schedules/change-request-sync/');
    expect(value).toContain('/api/duty-schedules/change-summary-report');
    expect(value).toContain('/api/duty-schedules/change-summary-report-sync/');
    expect(value).toContain(
      '/api/duty-schedules/change-summary-report/self-test/cleanup-bound-attachment',
    );
    expect(value).toContain(
      '/api/duty-schedules/change-adjustment/self-test/cleanup-bound-attachment',
    );
    expect(value).toContain(
      '/api/duty-schedules/change-summary-report/self-test/finalize-failed-cleanup',
    );
    expect(value).toContain('x-change-summary-failed-self-test-cleanup-proof');
    expect(value).toContain(
      'vnet-change-summary-report-failed-self-test-cleanup-v1',
    );
    expect(value).toContain('变更总结报告（风险低及以上）');
    expect(value).toContain('变更总结请求唯一ID');
    expect(value).toContain('变更总结请求指纹');
    expect(value).toContain('summaryBindingVerified');
    expect(value).toContain('verifyStorageAccessible');
    expect(value).toContain('self-test-deletion-state');
    expect(value).not.toContain('/download?ownerMutationId=');
    expect(value).not.toContain('verifyBoundStorage');
    expect(value).toMatch(
      /normalizeLabel\(fields\['变更等级（阿里）'\]\);\s*if \(level !== '低'\)/,
    );
    expect(value).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(value).not.toMatch(
      /(?:secret|token|authorization|cookie)\s*[:=]\s*['"`][A-Za-z0-9._-]{16,}['"`]/i,
    );
    expect(value).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/i);
  });

  it('signs failed-summary cleanup object sets canonically with an independent HMAC domain', () => {
    const result = runScenario(`
      const secret = Buffer.alloc(32, 7).toString('base64');
      const base = {
        changeRequestMutationId: 'change-request-11111111-1111-4111-8111-111111111111',
        clientMutationId: 'change-summary-report-33333333-3333-4333-8333-333333333333',
        changeRecordId: 'recChangeSummary',
        summaryMarker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786400000000-a1b2c3d4',
        summaryFingerprint: 'f'.repeat(64),
        changeObjectIds: ['ChangeStorage_999', 'ChangeStorage_123'],
        summaryObjectIds: ['SummaryStorage_999', 'SummaryStorage_456'],
        expiresAt: 1786400060000,
      };
      const proof = subject.createFailedSummaryCleanupProof(base, secret);
      const reordered = subject.createFailedSummaryCleanupProof({
        ...base,
        changeObjectIds: [...base.changeObjectIds].reverse(),
        summaryObjectIds: [...base.summaryObjectIds].reverse(),
      }, secret);
      const tampered = subject.createFailedSummaryCleanupProof({
        ...base,
        summaryFingerprint: 'e'.repeat(64),
      }, secret);
      process.stdout.write(JSON.stringify({ proof, reordered, tampered }));
    `);

    expect(result.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.reordered).toBe(result.proof);
    expect(result.tampered).not.toBe(result.proof);
  });

  it('builds an already-finished Shanghai schedule on or after 2026-06-01', () => {
    const result = runScenario(`
      const schedule = subject.buildPastCompletedSchedule(
        new Date('2026-08-11T12:00:00+08:00'),
      );
      const rejected = [];
      for (const value of [
        new Date('invalid'),
        new Date('2026-06-01T08:00:00+08:00'),
      ]) {
        try { subject.buildPastCompletedSchedule(value); }
        catch (error) { rejected.push(error.name); }
      }
      process.stdout.write(JSON.stringify({ schedule, rejected }));
    `);

    expect(result).toEqual({
      schedule: {
        startAt: '2026-08-10T09:00',
        endAt: '2026-08-10T18:00',
      },
      rejected: ['Error', 'Error'],
    });
  });

  it('builds a stable business fingerprint independent of mutation and signed URL', () => {
    const result = runScenario(`
      const base = {
        clientMutationId: 'change-summary-report-11111111-1111-4111-8111-111111111111',
        submitterName: '  Ａ　Ｂ  ',
        changeRecordId: 'recChangeSummary',
        summaryDocuments: [{
          name: 'summary.pdf', type: 'APPLICATION/PDF', size: 1024,
          objectStorage: {
            id: 'SummaryStorage_456',
            filePath: 'change-summary-reports/SummaryStorage_456/summary.pdf',
            bucketId: 'bucket-safe',
            url: 'https://cos.example/summary.pdf?secretId=first&signature=one',
          },
        }],
      };
      const first = subject.buildSummaryRequestFingerprint(base);
      const replay = subject.buildSummaryRequestFingerprint({
        ...base,
        clientMutationId: 'change-summary-report-22222222-2222-4222-8222-222222222222',
        submitterName: 'A B',
        summaryDocuments: [{
          ...base.summaryDocuments[0],
          objectStorage: {
            ...base.summaryDocuments[0].objectStorage,
            url: 'https://cos.example/summary.pdf?secretId=second&signature=two',
          },
        }],
      });
      const changedFile = subject.buildSummaryRequestFingerprint({
        ...base,
        summaryDocuments: [{
          ...base.summaryDocuments[0],
          objectStorage: {
            ...base.summaryDocuments[0].objectStorage,
            filePath: 'change-summary-reports/SummaryStorage_456/replaced.pdf',
          },
        }],
      });
      process.stdout.write(JSON.stringify({ first, replay, changedFile }));
    `);

    expect(result.first).toMatch(/^[a-f0-9]{64}$/);
    expect(result.replay).toBe(result.first);
    expect(result.changedFile).not.toBe(result.first);
  });

  it('accepts only a fast pending response with all three identities', () => {
    const result = runScenario(`
      const mutationId = 'change-summary-report-33333333-3333-4333-8333-333333333333';
      const response = {
        success: true,
        clientMutationId: mutationId,
        changeRecordId: 'recChangeSummary',
        pendingSync: true,
        taskId: mutationId,
        message: 'accepted',
      };
      const accepted = subject.assertFastSummaryAcceptance(
        response,
        { mutationId, changeRecordId: 'recChangeSummary', elapsedMs: 80, maxElapsedMs: 1000 },
      );
      const rejected = [];
      for (const [candidate, elapsedMs] of [
        [{ ...response, pendingSync: false }, 80],
        [{ ...response, taskId: 'change-summary-report-44444444-4444-4444-8444-444444444444' }, 80],
        [response, 1001],
      ]) {
        try {
          subject.assertFastSummaryAcceptance(candidate, {
            mutationId,
            changeRecordId: 'recChangeSummary',
            elapsedMs,
            maxElapsedMs: 1000,
          });
        } catch (error) { rejected.push(error.name); }
      }
      process.stdout.write(JSON.stringify({ accepted, rejected }));
    `);

    expect(result).toEqual({
      accepted: {
        taskId: 'change-summary-report-33333333-3333-4333-8333-333333333333',
        elapsedMs: 80,
      },
      rejected: ['Error', 'Error', 'Error'],
    });
  });

  it('polls to completion and rejects a task whose mutation/change/task identity drifts', () => {
    const result = runScenario(`
      const mutationId = 'change-summary-report-33333333-3333-4333-8333-333333333333';
      let polls = 0;
      const completed = await subject.waitForChangeSummaryReportCompletion(
        { success: true, clientMutationId: mutationId, changeRecordId: 'recChangeSummary', pendingSync: true, taskId: mutationId },
        { mutationId, changeRecordId: 'recChangeSummary' },
        {
          getChangeSummaryReportTask: async () => {
            polls += 1;
            return polls === 1
              ? { success: true, taskId: mutationId, clientMutationId: mutationId, changeRecordId: 'recChangeSummary', status: 'running', phase: 'uploading', message: 'running', updatedAt: '2026-08-11T00:00:00.000Z' }
              : { success: true, taskId: mutationId, clientMutationId: mutationId, changeRecordId: 'recChangeSummary', summaryReportRecordId: 'recSummaryReport', status: 'completed', phase: 'completed', message: 'done', updatedAt: '2026-08-11T00:00:01.000Z' };
          },
          waitBeforePoll: async () => undefined,
          summaryPollMaxAttempts: 3,
        },
      );
      let rejected = '';
      try {
        await subject.waitForChangeSummaryReportCompletion(
          { success: true, clientMutationId: mutationId, changeRecordId: 'recChangeSummary', pendingSync: true, taskId: mutationId },
          { mutationId, changeRecordId: 'recChangeSummary' },
          {
            getChangeSummaryReportTask: async () => ({ success: true, taskId: mutationId, clientMutationId: mutationId, changeRecordId: 'recOtherChange', status: 'completed', phase: 'completed', summaryReportRecordId: 'recSummaryReport', message: 'done', updatedAt: '2026-08-11T00:00:01.000Z' }),
          },
        );
      } catch (error) { rejected = error.name; }
      process.stdout.write(JSON.stringify({ completed, polls, rejected }));
    `);

    expect(result).toMatchObject({
      completed: {
        taskId: 'change-summary-report-33333333-3333-4333-8333-333333333333',
        changeRecordId: 'recChangeSummary',
        summaryReportRecordId: 'recSummaryReport',
        status: 'completed',
      },
      polls: 2,
      rejected: 'Error',
    });
  });

  it('runs the formal create/summary lifecycle, verifies readback/idempotency and cleans objects before rows', () => {
    const result = runScenario(`
      const uuids = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
      ];
      const mutationId = 'change-summary-report-33333333-3333-4333-8333-333333333333';
      const marker = 'CODEX-SELFTEST-CHANGE-SUMMARY-' + new Date('2026-08-11T12:00:00+08:00').getTime() + '-11111111';
      let state = null;
      let mainDeleted = false;
      let summaryDeleted = false;
      let summaryRequest = null;
      let createdPayload = null;
      let summaryPolls = 0;
      let summaryPosts = 0;
      let ledgerChecks = 0;
      let summaryCleanupRequest = null;
      const absent = new Set();
      const events = [];
      const queryCounts = { marker: 0, mutation: 0, relation: 0, mainId: 0, summaryId: 0 };
      const makeDocument = (id, owner, name) => ({
        name, originalname: name, type: 'application/pdf', mimetype: 'application/pdf', size: 1024,
        objectStorage: { id, filePath: 'change-summary-reports/' + id + '/' + name, bucketId: 'bucket-safe', url: '/api/duty-schedules/change-attachments/' + id + '/download' },
      });
      const main = {
        record_id: 'recChangeSummary',
        fields: {
          '变更简述': marker,
          '变更重要风险点（简述）': '自测清理校验：' + marker,
          '变更提交人': [{ name: 'Test Submitter' }],
          '变更进度': '已结束',
          '变更等级（阿里）': '低',
          '变更提交审核流程（内部）': '已通过',
          '计划开始日期（阿里）': Date.parse('2026-08-10T09:00:00+08:00'),
          '计划结束日期（阿里）': Date.parse('2026-08-10T18:00:00+08:00'),
          '变更文档': [{ file_token: 'box_change' }],
          '变更总结报告': [],
        },
      };
      let closing = null;
      const deps = {
        now: () => new Date('2026-08-11T12:00:00+08:00'),
        monotonicNow: (() => { const values = [100, 180]; return () => values.shift(); })(),
        randomUUID: () => uuids.shift(),
        primeLocalApi: async () => undefined,
        fetchLocalPeople: async () => [{ supervisorText: 'Test Submitter' }],
        stageDocument: async (owner, kind) => makeDocument(
          kind === 'change' ? 'ChangeStorage_123' : 'SummaryStorage_456', owner, kind + '.pdf',
        ),
        postChangeRequest: async (request) => {
          createdPayload = structuredClone(request);
          return {
            success: true, clientMutationId: request.clientMutationId, pendingSync: true,
            taskId: request.clientMutationId,
            record: { id: 'recChangeSummary', bitableRecordId: 'recChangeSummary' },
          };
        },
        getChangeRequestSyncTask: async (taskId) => ({
          success: true,
          task: { id: taskId, status: 'completed', result: { success: true, clientMutationId: taskId, record: { id: 'recChangeSummary', bitableRecordId: 'recChangeSummary' } } },
        }),
        postChangeSummaryReport: async (request) => {
          summaryPosts += 1;
          if (!summaryRequest) {
            summaryRequest = structuredClone(request);
            return { success: true, clientMutationId: request.clientMutationId, changeRecordId: request.changeRecordId, pendingSync: true, taskId: request.clientMutationId, message: 'accepted' };
          }
          if (JSON.stringify(request) !== JSON.stringify(summaryRequest)) {
            throw { response: { status: 409, data: {} } };
          }
          return { success: true, clientMutationId: request.clientMutationId, changeRecordId: request.changeRecordId, summaryReportRecordId: 'recSummaryReport', pendingSync: false, taskId: request.clientMutationId, message: 'done' };
        },
        getChangeSummaryReportTask: async () => {
          summaryPolls += 1;
          if (summaryPolls === 1) return { success: true, taskId: mutationId, clientMutationId: mutationId, changeRecordId: 'recChangeSummary', status: 'running', phase: 'uploading', message: 'running', updatedAt: '2026-08-11T04:00:00.000Z' };
          closing = {
            record_id: 'recSummaryReport',
            fields: {
              '变更关联': [{ link_record_ids: ['recChangeSummary'] }],
              '变更总结报告（风险低及以上）': [{ file_token: 'box_summary' }],
              '变更总结请求唯一ID': mutationId,
              '变更总结请求指纹': subject.buildSummaryRequestFingerprint(summaryRequest),
            },
          };
          main.fields['变更总结报告'] = [{
            attachmentToken: 'box_summary',
            extra: '{}',
            id: 'box_summary',
            mimeType: 'application/pdf',
            name: 'summary.pdf',
            size: 1024,
            timeStamp: 1786400000000,
          }];
          return { success: true, taskId: mutationId, clientMutationId: mutationId, changeRecordId: 'recChangeSummary', summaryReportRecordId: 'recSummaryReport', status: 'completed', phase: 'completed', message: 'done', updatedAt: '2026-08-11T04:00:01.000Z' };
        },
        queryMainByMarker: async () => { queryCounts.marker += 1; return mainDeleted ? [] : [main]; },
        querySummaryByMutation: async () => { queryCounts.mutation += 1; return summaryDeleted || !closing ? [] : [closing]; },
        querySummaryByChangeRecord: async () => { queryCounts.relation += 1; return summaryDeleted || !closing ? [] : [closing]; },
        getMainById: async (id) => { queryCounts.mainId += 1; return !mainDeleted && id === 'recChangeSummary' ? main : null; },
        getSummaryById: async (id) => { queryCounts.summaryId += 1; return !summaryDeleted && closing && id === 'recSummaryReport' ? closing : null; },
        verifyStorageAccessible: async ({ attachment }) => attachment.id === 'SummaryStorage_456',
        deleteSummaryBoundAttachment: async (request) => {
          const { objectId } = request;
          summaryCleanupRequest = structuredClone(request);
          if (summaryDeleted) throw new Error('closing row must still exist');
          events.push('summary-object:' + objectId); absent.add(objectId);
          return { success: true, objectId, missing: false };
        },
        deleteChangeBoundAttachment: async ({ objectId }) => {
          if (mainDeleted) throw new Error('main row must still exist');
          events.push('change-object:' + objectId); absent.add(objectId);
        },
        deleteStagedAttachment: async ({ id }) => { events.push('staged:' + id); absent.add(id); },
        isAttachmentAbsent: async ({ id }) => absent.has(id),
        deleteSummaryRecordById: async () => { events.push('summary-row'); summaryDeleted = true; },
        deleteMainRecordById: async () => { events.push('main-row'); mainDeleted = true; },
        writeState: async (value) => { state = structuredClone(value); },
        removeState: async () => { state = null; events.push('state-removed'); },
        waitBeforePoll: async () => undefined,
        waitBeforeRecheck: async () => undefined,
        verifyMutationLedgersSanitized: async () => { ledgerChecks += 1; },
      };
      const value = await subject.runChangeSummaryReportSelfTest({}, deps);
      process.stdout.write(JSON.stringify({
        value, state, events, summaryPosts, summaryPolls, queryCounts,
        ledgerChecks, summaryCleanupRequest,
        createPayload: {
          submitterExact: createdPayload.submitterName === 'Test Submitter',
          summary: createdPayload.summary,
          level: createdPayload.level,
          plannedStartAt: createdPayload.plannedStartAt,
          plannedEndAt: createdPayload.plannedEndAt,
          documentCount: createdPayload.stagedDocuments.length,
        },
      }));
    `);

    expect(result).toMatchObject({
      value: {
        ok: true,
        acceptedWithinMs: 80,
        replayVerified: true,
        tamperConflictVerified: true,
        strictReadbackVerified: true,
        boundStorageVerified: true,
        cleaned: true,
        residualCount: 0,
        objectResidualCount: 0,
      },
      state: null,
      summaryPosts: 3,
      summaryPolls: 2,
      ledgerChecks: 2,
      summaryCleanupRequest: {
        summaryReportRecordId: 'recSummaryReport',
        changeRecordId: 'recChangeSummary',
        changeRequestMutationId:
          'change-request-11111111-1111-4111-8111-111111111111',
        clientMutationId:
          'change-summary-report-33333333-3333-4333-8333-333333333333',
        objectId: 'SummaryStorage_456',
        summaryMarker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786420800000-11111111',
        submitterName: 'Test Submitter',
        fileToken: 'box_summary',
      },
      createPayload: {
        submitterExact: true,
        summary: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786420800000-11111111',
        level: '低',
        plannedStartAt: '2026-08-10T09:00',
        plannedEndAt: '2026-08-10T18:00',
        documentCount: 1,
      },
      queryCounts: {
        marker: 5,
        mutation: 4,
        relation: 4,
        mainId: 3,
        summaryId: 3,
      },
    });
    expect(result.events).toEqual([
      'summary-object:SummaryStorage_456',
      'change-object:ChangeStorage_123',
      'summary-row',
      'main-row',
      'state-removed',
    ]);
    expect(JSON.stringify(result.value)).not.toContain('Test Submitter');
  });

  it('checks both local mutation ledgers twice and rejects raw or sensitive residue', () => {
    const result = runScenario(`
      const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createHash } = await import('node:crypto');
      const state = subject.validateChangeSummarySelfTestState(${validStateSource});
      const root = await mkdtemp(join(tmpdir(), 'summary-ledger-check-'));
      const changeDir = join(root, 'change');
      const summaryDir = join(root, 'summary');
      await mkdir(changeDir); await mkdir(summaryDir);
      const writeTombstone = async (directory, mutationId, proof) => {
        const mutationHash = createHash('sha256').update(mutationId).digest('hex');
        await writeFile(
          join(directory, 'self-test-cleaned-' + mutationHash + '.json'),
          JSON.stringify({
            version: 1,
            state: 'self-test-cleaned',
            mutationHash,
            ...(proof ? { proofDigests: ['a'.repeat(64)] } : {}),
            cleanedAt: '2026-08-11T04:00:00.000Z',
          }),
        );
      };
      await writeTombstone(changeDir, state.createMutationId, false);
      await writeTombstone(summaryDir, state.summaryMutationId, true);
      const rawPath = join(changeDir, state.createMutationId + '.completed.json');
      await writeFile(rawPath, JSON.stringify({ submitterName: 'Sensitive Name' }));
      let rawRejected = '';
      try {
        await subject.verifyLocalMutationLedgersSanitized(state, {
          changeRequestLedgerDir: changeDir,
          summaryReportLedgerDir: summaryDir,
        });
      } catch (error) { rawRejected = error.name; }
      await rm(rawPath);
      const first = await subject.verifyLocalMutationLedgersSanitized(state, {
        changeRequestLedgerDir: changeDir,
        summaryReportLedgerDir: summaryDir,
      });
      const second = await subject.verifyLocalMutationLedgersSanitized(state, {
        changeRequestLedgerDir: changeDir,
        summaryReportLedgerDir: summaryDir,
      });
      const summaryHash = createHash('sha256').update(state.summaryMutationId).digest('hex');
      await writeFile(
        join(summaryDir, 'self-test-cleaned-' + summaryHash + '.json'),
        JSON.stringify({
          version: 1, state: 'self-test-cleaned', mutationHash: summaryHash,
          proofDigests: ['a'.repeat(64)], cleanedAt: '2026-08-11T04:00:00.000Z',
          submitterName: 'Sensitive Name',
        }),
      );
      let sensitiveRejected = '';
      try {
        await subject.verifyLocalMutationLedgersSanitized(state, {
          changeRequestLedgerDir: changeDir,
          summaryReportLedgerDir: summaryDir,
        });
      } catch (error) { sensitiveRejected = error.name; }
      await rm(root, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ rawRejected, first, second, sensitiveRejected }));
    `);

    expect(result).toEqual({
      rawRejected: 'UnsafeChangeSummarySelfTestCleanupError',
      first: { verified: true, ledgerCount: 2 },
      second: { verified: true, ledgerCount: 2 },
      sensitiveRejected: 'UnsafeChangeSummarySelfTestCleanupError',
    });
  });

  it('allows absent mutation ledgers only when the self-test failed before any external work', () => {
    const result = runScenario(`
      const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = await mkdtemp(join(tmpdir(), 'summary-ledger-preflight-'));
      const changeDir = join(root, 'change');
      const summaryDir = join(root, 'summary');
      await mkdir(changeDir); await mkdir(summaryDir);
      const base = ${validStateSource};
      const preflight = subject.validateChangeSummarySelfTestState({
        ...base,
        changeRecordId: '',
        summaryReportRecordId: '',
        summaryFingerprint: '',
        disposition: 'definitely-not-written',
        cleanupPhase: 'change-deleted',
        attachments: [],
      });
      const accepted = await subject.verifyLocalMutationLedgersSanitized(preflight, {
        changeRequestLedgerDir: changeDir,
        summaryReportLedgerDir: summaryDir,
      });
      let progressedRejected = '';
      try {
        await subject.verifyLocalMutationLedgersSanitized(
          subject.validateChangeSummarySelfTestState({
            ...preflight,
            changeRecordId: 'recChangeSummary',
            disposition: 'create-confirmed',
          }),
          {
            changeRequestLedgerDir: changeDir,
            summaryReportLedgerDir: summaryDir,
          },
        );
      } catch (error) { progressedRejected = error.name; }
      await rm(root, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ accepted, progressedRejected }));
    `);

    expect(result).toEqual({
      accepted: { verified: true, ledgerCount: 0 },
      progressedRejected: 'UnsafeChangeSummarySelfTestCleanupError',
    });
  });

  it('cleans definitely-not-written staged objects but preserves unknown-result state', () => {
    const result = runScenario(`
      const base = ${validStateSource};
      const events = [];
      const absent = new Set();
      const definite = subject.validateChangeSummarySelfTestState({
        ...base,
        changeRecordId: '',
        summaryReportRecordId: '',
        summaryFingerprint: '',
        disposition: 'definitely-not-written',
        attachments: [{ id: 'ChangeStorage_123', ownerMutationId: base.createMutationId, kind: 'change' }],
      });
      const definiteValue = await subject.cleanupChangeSummaryReportState(definite, {
        queryMainByMarker: async () => [], querySummaryByMutation: async () => [], querySummaryByChangeRecord: async () => [],
        getMainById: async () => null, getSummaryById: async () => null,
        deleteStagedAttachment: async ({ id }) => { events.push('staged:' + id); absent.add(id); },
        isAttachmentAbsent: async ({ id }) => absent.has(id),
        deleteSummaryRecordById: async () => { throw new Error('must not'); },
        deleteMainRecordById: async () => { throw new Error('must not'); },
        writeState: async () => undefined, removeState: async () => { events.push('removed'); },
      });
      let unknownDeletes = 0;
      let unknownRemoved = 0;
      let unknownName = '';
      try {
        await subject.cleanupChangeSummaryReportState({
          ...definite, disposition: 'unknown-result', attachments: [{ id: 'ChangeStorage_999', ownerMutationId: definite.createMutationId, kind: 'change' }],
        }, {
          queryMainByMarker: async () => [], querySummaryByMutation: async () => [], querySummaryByChangeRecord: async () => [],
          getMainById: async () => null, getSummaryById: async () => null,
          deleteStagedAttachment: async () => { unknownDeletes += 1; },
          isAttachmentAbsent: async () => false,
          writeState: async () => undefined, removeState: async () => { unknownRemoved += 1; },
        });
      } catch (error) { unknownName = error.name; }
      process.stdout.write(JSON.stringify({ definiteValue, events, unknownName, unknownDeletes, unknownRemoved }));
    `);

    expect(result).toMatchObject({
      definiteValue: {
        cleaned: true,
        residualCount: 0,
        objectResidualCount: 0,
      },
      events: ['staged:ChangeStorage_123', 'removed'],
      unknownName: 'UnsafeChangeSummarySelfTestCleanupError',
      unknownDeletes: 0,
      unknownRemoved: 0,
    });
  });

  it('cleans a staged-but-never-submitted summary in object-before-main-row order', () => {
    const result = runScenario(`
      let state = subject.validateChangeSummarySelfTestState({
        ...${validStateSource},
        summaryReportRecordId: '',
        summaryFingerprint: '',
        disposition: 'create-confirmed',
      });
      let mainDeleted = false;
      const absent = new Set();
      const events = [];
      const main = { record_id: state.changeRecordId, fields: {
        '变更简述': state.marker,
        '变更重要风险点（简述）': '自测清理校验：' + state.marker,
      }};
      const value = await subject.cleanupChangeSummaryReportState(state, {
        queryMainByMarker: async () => mainDeleted ? [] : [main],
        querySummaryByMutation: async () => [],
        querySummaryByChangeRecord: async () => [],
        getMainById: async () => mainDeleted ? null : main,
        getSummaryById: async () => null,
        deleteStagedAttachment: async ({ id }) => {
          events.push('staged-summary:' + id);
          absent.add(id);
        },
        deleteChangeBoundAttachment: async ({ objectId }) => {
          if (mainDeleted) throw new Error('main row must still exist');
          events.push('change-object:' + objectId);
          absent.add(objectId);
        },
        isAttachmentAbsent: async ({ id }) => absent.has(id),
        deleteSummaryRecordById: async () => { throw new Error('must not'); },
        deleteMainRecordById: async () => {
          events.push('main-row');
          mainDeleted = true;
        },
        writeState: async (next) => { state = structuredClone(next); },
        removeState: async () => { events.push('removed'); },
      });
      process.stdout.write(JSON.stringify({ value, state, events }));
    `);

    expect(result).toMatchObject({
      value: { cleaned: true, residualCount: 0, objectResidualCount: 0 },
      state: { cleanupPhase: 'change-deleted' },
    });
    expect(result.events).toEqual([
      'staged-summary:SummaryStorage_456',
      'change-object:ChangeStorage_123',
      'main-row',
      'removed',
    ]);
  });

  it('finalizes failed ledgers after strict Base/COS absence and retries a change-deleted cleanup without deleting external data again', () => {
    const result = runScenario(`
      let state = subject.validateChangeSummarySelfTestState({
        ...${validStateSource},
        summaryReportRecordId: '',
        disposition: 'summary-failed',
        cleanupPhase: 'change-deleted',
      });
      const events = [];
      const requests = [];
      let finalizeCalls = 0;
      let deleteCalls = 0;
      const dependencies = {
        queryMainByMarker: async () => { events.push('base'); return []; },
        querySummaryByMutation: async () => [],
        querySummaryByChangeRecord: async () => [],
        getMainById: async () => null,
        getSummaryById: async () => null,
        isAttachmentAbsent: async () => { events.push('cos'); return true; },
        finalizeFailedSummaryCleanup: async (request) => {
          finalizeCalls += 1;
          requests.push(structuredClone(request));
          events.push('finalize:' + finalizeCalls);
          if (finalizeCalls === 1) throw new Error('simulated lost response');
          return { success: true };
        },
        verifyMutationLedgersSanitized: async () => { events.push('ledger'); },
        deleteStagedAttachment: async () => { deleteCalls += 1; },
        deleteSummaryBoundAttachment: async () => { deleteCalls += 1; },
        deleteChangeBoundAttachment: async () => { deleteCalls += 1; },
        deleteSummaryRecordById: async () => { deleteCalls += 1; },
        deleteMainRecordById: async () => { deleteCalls += 1; },
        writeState: async (next) => { state = structuredClone(next); },
        removeState: async () => { events.push('removed'); },
        waitBeforeRecheck: async () => undefined,
      };
      let firstFailure = '';
      try {
        await subject.cleanupChangeSummaryReportState(state, dependencies);
      } catch (error) {
        firstFailure = error.message;
      }
      events.push('retry-start');
      const value = await subject.cleanupChangeSummaryReportState(state, dependencies);
      process.stdout.write(JSON.stringify({
        value, state, events, requests, finalizeCalls, deleteCalls, firstFailure,
      }));
    `);

    expect(result).toMatchObject({
      value: { cleaned: true, residualCount: 0, objectResidualCount: 0 },
      state: {
        disposition: 'summary-failed',
        cleanupPhase: 'change-deleted',
        summaryReportRecordId: '',
      },
      finalizeCalls: 2,
      deleteCalls: 0,
      firstFailure: 'simulated lost response',
      requests: [
        {
          changeRequestMutationId:
            'change-request-11111111-1111-4111-8111-111111111111',
          clientMutationId:
            'change-summary-report-33333333-3333-4333-8333-333333333333',
          changeRecordId: 'recChangeSummary',
          summaryMarker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786400000000-a1b2c3d4',
          summaryFingerprint: 'f'.repeat(64),
          changeObjectIds: ['ChangeStorage_123'],
          summaryObjectIds: ['SummaryStorage_456'],
        },
        {
          changeRequestMutationId:
            'change-request-11111111-1111-4111-8111-111111111111',
          clientMutationId:
            'change-summary-report-33333333-3333-4333-8333-333333333333',
          changeRecordId: 'recChangeSummary',
          summaryMarker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786400000000-a1b2c3d4',
          summaryFingerprint: 'f'.repeat(64),
          changeObjectIds: ['ChangeStorage_123'],
          summaryObjectIds: ['SummaryStorage_456'],
        },
      ],
    });
    const events = result.events as string[];
    const firstFinalize = events.indexOf('finalize:1');
    const retryStart = events.indexOf('retry-start');
    const secondFinalize = events.indexOf('finalize:2');
    const firstLedger = events.indexOf('ledger');
    expect(firstFinalize).toBeGreaterThan(events.indexOf('cos'));
    expect(events.slice(0, firstFinalize)).toContain('base');
    expect(
      events.slice(0, firstFinalize).filter((item) => item === 'cos'),
    ).toHaveLength(4);
    expect(retryStart).toBe(firstFinalize + 1);
    expect(secondFinalize).toBeGreaterThan(retryStart);
    expect(events.slice(retryStart + 1, secondFinalize)).toContain('base');
    expect(
      events
        .slice(retryStart + 1, secondFinalize)
        .filter((item) => item === 'cos'),
    ).toHaveLength(4);
    expect(firstLedger).toBeGreaterThan(secondFinalize);
    expect(events.filter((item) => item === 'ledger')).toHaveLength(2);
    expect(events.at(-1)).toBe('removed');
  });

  it('recovers a known closing record id before filtered queries and deletes it before the main row', () => {
    const result = runScenario(`
      let state = subject.validateChangeSummarySelfTestState({
        ...${validStateSource},
        disposition: 'summary-failed',
      });
      let mainDeleted = false;
      let summaryDeleted = false;
      const absent = new Set();
      const events = [];
      const main = { record_id: state.changeRecordId, fields: {
        '变更简述': state.marker,
        '变更重要风险点（简述）': '自测清理校验：' + state.marker,
      }};
      const closing = { record_id: state.summaryReportRecordId, fields: {
        '变更关联': [{
          record_ids: [state.changeRecordId],
          table_id: 'tbl4a140b7731177',
          text: 'self-test change',
          text_arr: ['self-test change'],
          type: 'text',
        }],
        '变更总结报告（风险低及以上）': [{ file_token: 'box_summary' }],
        '变更总结请求唯一ID': state.summaryMutationId,
        '变更总结请求指纹': state.summaryFingerprint,
      }};
      const value = await subject.cleanupChangeSummaryReportState(state, {
        queryMainByMarker: async () => mainDeleted ? [] : [main],
        querySummaryByMutation: async () => [],
        querySummaryByChangeRecord: async () => [],
        getMainById: async () => mainDeleted ? null : main,
        getSummaryById: async () => summaryDeleted ? null : closing,
        deleteSummaryBoundAttachment: async ({ objectId }) => {
          if (summaryDeleted) throw new Error('closing row must still exist');
          events.push('summary-object:' + objectId);
          absent.add(objectId);
          return { success: true, objectId, missing: false };
        },
        deleteChangeBoundAttachment: async ({ objectId }) => {
          if (mainDeleted) throw new Error('main row must still exist');
          events.push('change-object:' + objectId);
          absent.add(objectId);
        },
        isAttachmentAbsent: async ({ id }) => absent.has(id),
        deleteSummaryRecordById: async () => {
          events.push('summary-row');
          summaryDeleted = true;
        },
        deleteMainRecordById: async () => {
          events.push('main-row');
          mainDeleted = true;
        },
        writeState: async (next) => { state = structuredClone(next); },
        removeState: async () => { events.push('removed'); },
      });
      process.stdout.write(JSON.stringify({ value, state, events }));
    `);

    expect(result).toMatchObject({
      value: {
        cleaned: true,
        summaryBindingVerified: true,
        residualCount: 0,
        objectResidualCount: 0,
      },
      state: { cleanupPhase: 'change-deleted' },
    });
    expect(result.events).toEqual([
      'summary-object:SummaryStorage_456',
      'change-object:ChangeStorage_123',
      'summary-row',
      'main-row',
      'removed',
    ]);
  });

  it('adopts and safely cleans a main record recovered after an unknown create result', () => {
    const result = runScenario(`
      let state = subject.validateChangeSummarySelfTestState({
        ...${validStateSource},
        changeRecordId: '',
        summaryReportRecordId: '',
        summaryFingerprint: '',
        disposition: 'unknown-result',
        attachments: [{ id: 'ChangeStorage_123', ownerMutationId: 'change-request-11111111-1111-4111-8111-111111111111', kind: 'change' }],
      });
      let mainDeleted = false;
      let objectAbsent = false;
      const events = [];
      const main = { record_id: 'recChangeSummary', fields: {
        '变更简述': state.marker,
        '变更重要风险点（简述）': '自测清理校验：' + state.marker,
      }};
      const value = await subject.cleanupChangeSummaryReportState(state, {
        queryMainByMarker: async () => mainDeleted ? [] : [main],
        querySummaryByMutation: async () => [],
        querySummaryByChangeRecord: async () => [],
        getMainById: async () => mainDeleted ? null : main,
        getSummaryById: async () => null,
        deleteChangeBoundAttachment: async ({ recordId, objectId }) => {
          events.push('change-object:' + recordId + ':' + objectId);
          objectAbsent = true;
        },
        isAttachmentAbsent: async () => objectAbsent,
        deleteMainRecordById: async (recordId) => {
          events.push('main-row:' + recordId);
          mainDeleted = true;
        },
        writeState: async (next) => { state = structuredClone(next); },
        removeState: async () => { events.push('removed'); },
      });
      process.stdout.write(JSON.stringify({ value, state, events }));
    `);

    expect(result).toMatchObject({
      value: { cleaned: true, residualCount: 0, objectResidualCount: 0 },
      state: {
        changeRecordId: 'recChangeSummary',
        cleanupPhase: 'change-deleted',
      },
    });
    expect(result.events).toEqual([
      'change-object:recChangeSummary:ChangeStorage_123',
      'main-row:recChangeSummary',
      'removed',
    ]);
  });

  it('tracks a recoverable COS object before strict stage-response validation', () => {
    const result = runScenario(`
      let state = null;
      let absent = false;
      const events = [];
      let errorName = '';
      try {
        await subject.runChangeSummaryReportSelfTest({}, {
          now: () => new Date('2026-08-11T12:00:00+08:00'),
          randomUUID: (() => { const values = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']; return () => values.shift(); })(),
          primeLocalApi: async () => undefined,
          fetchLocalPeople: async () => [{ supervisorText: 'Test Submitter' }],
          stageDocument: async () => ({
            name: 'malformed.pdf', type: 'application/pdf', size: 4096,
            objectStorage: { id: 'ChangeStorage_123', url: '/api/duty-schedules/change-attachments/ChangeStorage_123/download' },
          }),
          queryMainByMarker: async () => [],
          querySummaryByMutation: async () => [],
          querySummaryByChangeRecord: async () => [],
          getMainById: async () => null,
          getSummaryById: async () => null,
          deleteStagedAttachment: async ({ id }) => { events.push('staged:' + id); absent = true; },
          isAttachmentAbsent: async () => absent,
          deleteMainRecordById: async () => { throw new Error('must not'); },
          deleteSummaryRecordById: async () => { throw new Error('must not'); },
          writeState: async (next) => { state = structuredClone(next); },
          removeState: async () => { state = null; events.push('removed'); },
        });
      } catch (error) {
        errorName = error.name;
      }
      process.stdout.write(JSON.stringify({ errorName, state, events }));
    `);

    expect(result).toEqual({
      errorName: 'Error',
      state: null,
      events: ['staged:ChangeStorage_123', 'removed'],
    });
  });

  it('refuses ambiguous or identity-mismatched cleanup before deleting anything', () => {
    const result = runScenario(`
      const state = subject.validateChangeSummarySelfTestState(${validStateSource});
      let deletes = 0;
      const makeMain = (id, marker = state.marker) => ({ record_id: id, fields: {
        '变更简述': marker,
        '变更重要风险点（简述）': '自测清理校验：' + state.marker,
      }});
      const names = [];
      for (const records of [
        [makeMain(state.changeRecordId), makeMain('recOtherChange')],
        [makeMain(state.changeRecordId, 'WRONG')],
      ]) {
        try {
          await subject.cleanupChangeSummaryReportState(state, {
            queryMainByMarker: async () => records,
            querySummaryByMutation: async () => [], querySummaryByChangeRecord: async () => [],
            getMainById: async () => records[0], getSummaryById: async () => null,
            deleteSummaryBoundAttachment: async () => { deletes += 1; },
            deleteChangeBoundAttachment: async () => { deletes += 1; },
            deleteStagedAttachment: async () => { deletes += 1; },
            isAttachmentAbsent: async () => true,
            deleteSummaryRecordById: async () => { deletes += 1; },
            deleteMainRecordById: async () => { deletes += 1; },
            writeState: async () => { deletes += 1; }, removeState: async () => { deletes += 1; },
          });
        } catch (error) { names.push(error.name); }
      }
      process.stdout.write(JSON.stringify({ names, deletes }));
    `);

    expect(result).toEqual({
      names: [
        'UnsafeChangeSummarySelfTestCleanupError',
        'UnsafeChangeSummarySelfTestCleanupError',
      ],
      deletes: 0,
    });
  });

  it('resumes cleanup-only after an armed closing-row delete without repeating it', () => {
    const result = runScenario(`
      let state = subject.validateChangeSummarySelfTestState({
        ...${validStateSource}, cleanupPhase: 'summary-delete-armed',
      });
      const main = { record_id: state.changeRecordId, fields: {
        '变更简述': state.marker,
        '变更重要风险点（简述）': '自测清理校验：' + state.marker,
      }};
      const events = [];
      const value = await subject.cleanupChangeSummaryReportState(state, {
        queryMainByMarker: async () => events.includes('main-row') ? [] : [main],
        querySummaryByMutation: async () => [], querySummaryByChangeRecord: async () => [],
        getMainById: async () => events.includes('main-row') ? null : main,
        getSummaryById: async () => null,
        isAttachmentAbsent: async () => true,
        deleteSummaryRecordById: async () => { throw new Error('must not repeat'); },
        deleteMainRecordById: async () => { events.push('main-row'); },
        writeState: async (next) => { state = structuredClone(next); },
        removeState: async () => { events.push('removed'); },
        waitBeforeRecheck: async () => undefined,
      });
      process.stdout.write(JSON.stringify({ value, state, events }));
    `);

    expect(result).toMatchObject({
      value: { cleaned: true, residualCount: 0, objectResidualCount: 0 },
      state: { cleanupPhase: 'change-deleted' },
      events: ['main-row', 'removed'],
    });
  });

  it('rejects forged or PII-bearing recovery state', () => {
    const result = runScenario(`
      const valid = ${validStateSource};
      const forged = [
        { ...valid, createMutationId: 'change-request-forged' },
        { ...valid, marker: '普通变更' },
        { ...valid, changeRecordId: '../rec' },
        { ...valid, submitterName: '不应持久化的姓名' },
        { ...valid, attachments: [{ id: '../bad', ownerMutationId: valid.createMutationId, kind: 'change' }] },
      ];
      const names = [];
      for (const value of forged) {
        try { subject.validateChangeSummarySelfTestState(value); }
        catch (error) { names.push(error.name); }
      }
      process.stdout.write(JSON.stringify(names));
    `);

    expect(result).toEqual(
      Array(5).fill('UnsafeChangeSummarySelfTestCleanupError'),
    );
  });

  it('prints only safe stage/code/ref metadata and never response details or URL queries', () => {
    const result = runScenario(`
      const error = new Error('Bearer secret-token https://cos.example/a?secretId=never-print');
      error.response = { status: 400, data: { message: '变更提交人“Sensitive Name”与 token=private 不一致' } };
      process.stdout.write(JSON.stringify(subject.buildSafeCliError(error, 'execute')));
    `);

    expect(Object.keys(result).sort()).toEqual([
      'code',
      'operation',
      'reason',
      'safeRef',
      'stage',
    ]);
    expect(result).toMatchObject({
      stage: 'execute',
      operation: 'unknown',
      code: 'SELF_TEST_FAILED',
    });
    expect(result.safeRef).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('never-print');
    expect(JSON.stringify(result)).not.toContain('Sensitive Name');
    expect(JSON.stringify(result)).not.toContain('?');
  });

  it('never allows the CLI acceptance threshold to exceed one second', () => {
    const result = runScenario(`
      const accepted = subject.parseArguments(['run', '--max-acceptance-ms', '1000']);
      let rejected = '';
      try {
        subject.parseArguments(['run', '--max-acceptance-ms', '1001']);
      } catch (error) {
        rejected = error.name;
      }
      process.stdout.write(JSON.stringify({ maxAcceptanceMs: accepted.maxAcceptanceMs, rejected }));
    `);

    expect(result).toEqual({ maxAcceptanceMs: 1000, rejected: 'Error' });
  });

  it('wires explicit run and cleanup-only package commands', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['self-test:change-summary-report']).toBe(
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-change-summary-report.mjs run',
    );
    expect(packageJson.scripts['self-test:change-summary-report:cleanup']).toBe(
      'npm run build:server && node scripts/run-with-env.mjs node scripts/self-test-change-summary-report.mjs cleanup-only',
    );
  });
});
