import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
const scriptPath = resolve(root, 'scripts/self-test-change-adjustment.mjs');
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
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function scriptSource(): string {
  return readFileSync(scriptPath, 'utf8');
}

describe('change request and adjustment real-data self-test', () => {
  it('uses only the local personnel/change APIs and contains no embedded credential', () => {
    const source = scriptSource();

    expect(source).toContain('/api/bitable/person-profiles?scope=leave');
    expect(source).toContain('/api/duty-schedules/change-attachments/stage');
    expect(source).toContain('/api/duty-schedules/change-request');
    expect(source).toContain('/api/duty-schedules/change-request-sync/');
    expect(source).toContain('/api/duty-schedules/change-adjustment');
    expect(source).toContain('/api/duty-schedules/change-attachments/');
    expect(source).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(source).not.toMatch(
      /(?:app[_-]?token|app[_-]?secret|tenant_access_token|authorization|cookie)\s*[:=]\s*['"`][A-Za-z0-9._-]{16,}['"`]/i,
    );
    expect(source).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/i);
  });

  it('verifies an in-memory duty_editor session before sending CSRF-protected writes', () => {
    const result = runScenario(`
      const csrfToken = 'a'.repeat(43);
      const accessSessionToken = 'signed_payload.signed_signature';
      const events = [];
      const client = {
        get: async (path, config = {}) => {
          events.push('get:' + path);
          if (path === '/') {
            return {
              headers: {
                'set-cookie': ['suda-csrf-token=' + csrfToken + '; Path=/'],
              },
            };
          }
          if (path === '/api/access/session') {
            const cookie = String(config.headers?.Cookie || '');
            return {
              data: {
                role: cookie.includes('vnet_access_session=' + accessSessionToken)
                  ? 'duty_editor'
                  : 'guest',
              },
            };
          }
          throw new Error('unexpected GET');
        },
        post: async (path, _data, config = {}) => {
          events.push('post:' + path);
          const cookie = String(config.headers?.Cookie || '');
          return {
            data: {
              hasCsrfCookie: cookie.includes('suda-csrf-token=' + csrfToken),
              hasAccessCookie: cookie.includes(
                'vnet_access_session=' + accessSessionToken,
              ),
              hasCsrfHeader:
                config.headers?.['x-suda-csrf-token'] === csrfToken,
            },
          };
        },
      };
      const session = subject.createLoopbackApiSession({
        baseUrl: 'https://127.0.0.1:3001',
        client,
        accessSessionToken,
      });
      const primed = await session.prime();
      const posted = await session.post('/api/duty-schedules/change-adjustment', {});
      process.stdout.write(JSON.stringify({ primed, posted: posted.data, events }));
    `);

    expect(result).toEqual({
      primed: { csrfEnabled: true, role: 'duty_editor' },
      posted: {
        hasCsrfCookie: true,
        hasAccessCookie: true,
        hasCsrfHeader: true,
      },
      events: [
        'get:/',
        'get:/api/access/session',
        'post:/api/duty-schedules/change-adjustment',
      ],
    });
  });

  it('rejects a guest or mismatched session before any write request', () => {
    const result = runScenario(`
      const csrfToken = 'b'.repeat(43);
      let posts = 0;
      const client = {
        get: async (path) => path === '/'
          ? { headers: { 'set-cookie': ['suda-csrf-token=' + csrfToken + '; Path=/'] } }
          : { data: { role: 'guest' } },
        post: async () => { posts += 1; return { data: {} }; },
      };
      const session = subject.createLoopbackApiSession({
        baseUrl: 'https://127.0.0.1:3001',
        client,
        accessSessionToken: 'signed_payload.signed_signature',
      });
      let errorName = '';
      try { await session.prime(); } catch (error) { errorName = error.name; }
      process.stdout.write(JSON.stringify({ errorName, posts }));
    `);

    expect(result).toEqual({ errorName: 'Error', posts: 0 });
  });

  it('selects one exact non-ambiguous submitter from the local cache', () => {
    const result = runScenario(`
      const selected = subject.selectExactLocalSubmitter([
        { supervisorText: '  Beta  ' },
        { supervisorText: 'Alpha' },
        { supervisorText: 'alpha' },
        { supervisorText: '' },
      ]);
      let ambiguous = '';
      try {
        subject.selectExactLocalSubmitter([
          { supervisorText: 'Same' }, { supervisorText: ' same ' },
        ]);
      } catch (error) {
        ambiguous = error.name;
      }
      process.stdout.write(JSON.stringify({ selected, ambiguous }));
    `);

    expect(result).toEqual({ selected: 'Beta', ambiguous: 'Error' });
  });

  it('requires the dedicated change submitter field to be a writable person field', () => {
    const result = runScenario(`
      const valid = subject.assertWritableChangeSubmitterField([
        { fieldName: '系统创建人', type: 1003, writable: false },
        { fieldName: '变更提交人', type: 11, writable: true },
      ]);
      const invalid = [];
      for (const schemas of [
        [{ fieldName: '变更提交人', type: 1003, writable: false }],
        [{ fieldName: '申请提交人', type: 11, writable: true }],
        [{ fieldName: '变更提交人', type: 11, writable: false }],
      ]) {
        try { subject.assertWritableChangeSubmitterField(schemas); }
        catch (error) { invalid.push(error.name); }
      }
      process.stdout.write(JSON.stringify({ valid, invalid }));
    `);

    expect(result).toEqual({
      valid: { fieldName: '变更提交人', type: 11, writable: true },
      invalid: ['Error', 'Error', 'Error'],
    });
  });

  it('treats a failed background attachment task as post-commit and keeps the formal record identity', () => {
    const result = runScenario(`
      const mutationId = 'change-request-11111111-1111-4111-8111-111111111111';
      try {
        await subject.waitForChangeRequestSyncCompletion({
          success: true,
          clientMutationId: mutationId,
          pendingSync: true,
          taskId: mutationId,
          record: { id: 'recFormal', bitableRecordId: 'recFormal' },
          message: '已受理',
        }, mutationId, {
          getChangeRequestSyncTask: async () => ({
            success: true,
            task: {
              id: mutationId,
              status: 'failed',
              message: 'remote details must not be copied',
              result: { recordId: 'recFormal' },
            },
          }),
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          message: error.message,
          writeDisposition: error.writeDisposition,
          recordState: error.recordState,
        }));
      }
    `);

    expect(result).toEqual({
      message: '变更申请正式记录已创建，但后台附件同步失败',
      writeDisposition: 'confirmed-post-commit-pending',
      recordState: 'created',
    });
  });

  it('generates a structurally valid PDF fixture just above 20 MiB', () => {
    const directory = mkdtempSync(join(tmpdir(), 'change-self-test-pdf-'));
    const target = join(directory, 'scheme.pdf');
    try {
      const result = runScenario(`
        const path = ${JSON.stringify(target)};
        const size = 20 * 1024 * 1024 + 64 * 1024;
        const descriptor = await subject.writeLargePdfFixture(path, size, 'unit');
        const checked = await subject.inspectLargePdfFixture(path);
        process.stdout.write(JSON.stringify({ descriptor, checked }));
      `);

      expect(statSync(target).size).toBe(20 * 1024 * 1024 + 64 * 1024);
      expect(readFileSync(target).subarray(0, 8).toString('ascii')).toBe(
        '%PDF-1.7',
      );
      expect(result).toMatchObject({
        descriptor: {
          size: 20 * 1024 * 1024 + 64 * 1024,
          mimeType: 'application/pdf',
        },
        checked: { valid: true, aboveWholeUploadLimit: true },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('generates a structurally valid PDF fixture at exactly 14 MiB', () => {
    const directory = mkdtempSync(join(tmpdir(), 'change-self-test-pdf-'));
    const target = join(directory, 'scheme-14mib.pdf');
    try {
      const result = runScenario(`
        const path = ${JSON.stringify(target)};
        const size = 14 * 1024 * 1024;
        const descriptor = await subject.writeLargePdfFixture(path, size, 'unit-14mib');
        const checked = await subject.inspectLargePdfFixture(path);
        process.stdout.write(JSON.stringify({ descriptor, checked }));
      `);

      expect(statSync(target).size).toBe(14 * 1024 * 1024);
      expect(readFileSync(target).subarray(0, 8).toString('ascii')).toBe(
        '%PDF-1.7',
      );
      expect(result).toMatchObject({
        descriptor: {
          size: 14 * 1024 * 1024,
          mimeType: 'application/pdf',
        },
        checked: { valid: true, aboveWholeUploadLimit: false },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses an exact bounded --scheme-bytes value and rejects invalid sizes', () => {
    const result = runScenario(`
      const accepted = subject.parseChangeAdjustmentSelfTestArguments([
        'run', '--scheme-bytes', '14680064',
      ]);
      const defaults = subject.parseChangeAdjustmentSelfTestArguments(['run']);
      const rejected = [];
      for (const args of [
        ['run', '--scheme-bytes'],
        ['run', '--scheme-bytes', '1023'],
        ['run', '--scheme-bytes', '14680064.5'],
        ['run', '--scheme-bytes', String(200 * 1024 * 1024 + 1)],
      ]) {
        try {
          subject.parseChangeAdjustmentSelfTestArguments(args);
        } catch (error) {
          rejected.push(error.name);
        }
      }
      process.stdout.write(JSON.stringify({
        accepted: accepted.schemeBytes,
        defaults: defaults.schemeBytes,
        rejected,
      }));
    `);

    expect(result).toEqual({
      accepted: 14 * 1024 * 1024,
      defaults: null,
      rejected: Array(4).fill('Error'),
    });
  });

  it('accepts a staged 14 MiB scheme only when that exact size was requested', () => {
    const result = runScenario(`
      const size = 14 * 1024 * 1024;
      const document = {
        name: 'scheme.pdf',
        size,
        objectStorage: {
          id: 'ExactSchemeStorage_123',
          url: '/api/duty-schedules/change-attachments/ExactSchemeStorage_123/download',
        },
      };
      const accepted = subject.validateStagedDocument(
        document,
        'initial',
        size,
      );
      const rejected = [];
      for (const [candidate, expected] of [
        [{ ...document, size: size + 1 }, size],
        [document, null],
      ]) {
        try {
          subject.validateStagedDocument(candidate, 'initial', expected);
        } catch (error) {
          rejected.push(error.name);
        }
      }
      process.stdout.write(JSON.stringify({
        acceptedSize: accepted.size,
        rejected,
      }));
    `);

    expect(result).toEqual({
      acceptedSize: 14 * 1024 * 1024,
      rejected: ['Error', 'Error'],
    });
  });

  it('validates an external scheme against the requested size without weakening the default boundary', () => {
    const result = runScenario(`
      const fourteenMiB = 14 * 1024 * 1024;
      const defaultBytes = 20 * 1024 * 1024 + 64 * 1024;
      const exact = {
        valid: true,
        aboveWholeUploadLimit: false,
        size: fourteenMiB,
      };
      const defaultFixture = {
        valid: true,
        aboveWholeUploadLimit: true,
        size: defaultBytes,
      };
      const acceptedExact = subject.validateSchemeFixtureExpectation(
        exact,
        fourteenMiB,
      );
      const acceptedDefault = subject.validateSchemeFixtureExpectation(
        defaultFixture,
        null,
      );
      const rejected = [];
      for (const [fixture, expected] of [
        [exact, null],
        [{ ...exact, size: fourteenMiB + 1 }, fourteenMiB],
        [{ ...exact, valid: false }, fourteenMiB],
      ]) {
        try {
          subject.validateSchemeFixtureExpectation(fixture, expected);
        } catch (error) {
          rejected.push(error.name);
        }
      }
      process.stdout.write(JSON.stringify({
        acceptedExact: acceptedExact.size,
        acceptedDefault: acceptedDefault.size,
        rejected,
      }));
    `);

    expect(result).toEqual({
      acceptedExact: 14 * 1024 * 1024,
      acceptedDefault: 20 * 1024 * 1024 + 64 * 1024,
      rejected: ['Error', 'Error', 'Error'],
    });
  });

  it('creates, replays, adjusts, replays and then removes the exact Base record and every object', () => {
    const result = runScenario(`
      const uuids = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ];
      let state = null;
      let deleted = false;
      let objectDeleted = new Set();
      let record = null;
      let initialRequest = null;
      let adjustmentRequest = null;
      let syncPolls = 0;
      let stateRecordIdAtFirstPoll = '';
      const events = [];
      const makeDocument = (id, name, size, type) => ({
        name, originalname: name, type, mimetype: type, size,
        objectStorage: {
          id,
          filePath: 'change-attachments/v1/' + id + '/' + name,
          bucketId: 'bucket-safe',
          url: '/api/duty-schedules/change-attachments/' + id + '/download',
        },
      });
      const deps = {
        now: () => new Date('2026-08-09T10:00:00+08:00'),
        randomUUID: () => uuids.shift(),
        primeLocalApi: async () => undefined,
        fetchLocalPeople: async () => [{ supervisorText: 'Test Submitter' }],
        assertWritableSubmitterField: async () => {
          events.push('submitter-field:writable');
        },
        stageLargeScheme: async (owner, label) => {
          const id = label === 'initial' ? 'InitialStorage_123' : 'ReplacementStorage_456';
          return makeDocument(id, label + '.pdf', 20 * 1024 * 1024 + 1, 'application/pdf');
        },
        stageEvidence: async () => makeDocument(
          'EvidenceStorage_789', 'evidence.png', 68, 'image/png'
        ),
        writeState: async (value) => { state = structuredClone(value); },
        removeState: async () => { state = null; events.push('state-removed'); },
        postChangeRequest: async (request) => {
          if (!initialRequest) {
            initialRequest = structuredClone(request);
            record = {
              record_id: 'recChangeExact',
              last_modified_time: Date.parse('2026-08-09T10:01:00+08:00'),
              fields: {
                '变更简述': request.summary,
                '变更重要风险点（简述）': '自测清理校验：' + request.summary,
                '变更提交人': [{ id: 'ou_redacted', name: request.submitterName }],
                '计划开始日期（阿里）': Date.parse(request.plannedStartAt + ':00+08:00'),
                '计划结束日期（阿里）': Date.parse(request.plannedEndAt + ':00+08:00'),
                '变更文档': [],
              },
            };
            return {
              success: true,
              clientMutationId: request.clientMutationId,
              pendingSync: true,
              taskId: request.clientMutationId,
              record: {
                id: 'recChangeExact', bitableRecordId: 'recChangeExact',
                title: request.summary,
                startDate: request.plannedStartAt,
                endDate: request.plannedEndAt,
                actualStartDate: null, actualEndDate: null,
                plannedDelayStartDate: null, plannedDelayEndDate: null,
                level: request.level, type: request.changeType,
                progress: '附件同步中', executor: null,
                buildings: request.buildings,
                riskSummary: request.riskSummary, isKey: false,
                createdAt: '2026-08-09T02:01:00.000Z',
                updatedAt: '2026-08-09T02:00:00.000Z',
              },
              message: '已受理',
            };
          } else if (request.summary !== initialRequest.summary) {
            throw { response: { status: 409, data: {} } };
          }
          return {
            success: true,
            clientMutationId: request.clientMutationId,
            record: {
              id: 'recChangeExact', bitableRecordId: 'recChangeExact',
              title: request.summary,
              startDate: request.plannedStartAt,
              endDate: request.plannedEndAt,
              actualStartDate: null, actualEndDate: null,
              plannedDelayStartDate: null, plannedDelayEndDate: null,
              level: request.level, type: request.changeType, progress: null,
              executor: null, buildings: request.buildings,
              riskSummary: request.riskSummary, isKey: false,
              createdAt: '2026-08-09T02:01:00.000Z',
              updatedAt: '2026-08-09T02:00:00.000Z',
            },
            message: '已同步',
          };
        },
        getChangeRequestSyncTask: async (taskId) => {
          if (taskId !== initialRequest.clientMutationId) {
            throw new Error('wrong task');
          }
          syncPolls += 1;
          if (syncPolls === 1) {
            stateRecordIdAtFirstPoll = state?.recordId || '';
            return {
              success: true,
              task: { id: taskId, status: 'running', message: '同步中' },
            };
          }
          record.fields['变更文档'] = [
            { file_token: 'box_initial', name: 'initial.pdf' },
          ];
          return {
            success: true,
            task: {
              id: taskId,
              status: 'completed',
              message: '已同步',
              result: {
                success: true,
                clientMutationId: initialRequest.clientMutationId,
                record: {
                  id: 'recChangeExact', bitableRecordId: 'recChangeExact',
                  title: initialRequest.summary,
                  startDate: initialRequest.plannedStartAt,
                  endDate: initialRequest.plannedEndAt,
                  actualStartDate: null, actualEndDate: null,
                  plannedDelayStartDate: null, plannedDelayEndDate: null,
                  level: initialRequest.level, type: initialRequest.changeType,
                  progress: null, executor: null,
                  buildings: initialRequest.buildings,
                  riskSummary: initialRequest.riskSummary, isKey: false,
                  createdAt: '2026-08-09T02:01:00.000Z',
                  updatedAt: '2026-08-09T02:01:00.000Z',
                },
                message: '已同步',
              },
            },
          };
        },
        waitBeforeSyncPoll: async () => undefined,
        postChangeAdjustment: async (request) => {
          if (!adjustmentRequest) {
            adjustmentRequest = structuredClone(request);
            record.last_modified_time = Date.parse('2026-08-09T10:02:00+08:00');
            record.fields['计划延迟开始日期'] = Date.parse(request.plannedDelayStartDate + ':00+08:00');
            record.fields['计划延迟结束日期'] = Date.parse(request.plannedDelayEndDate + ':00+08:00');
            record.fields['延期理由'] = request.reason;
            record.fields['延期举证'] = [{ file_token: 'box_evidence', name: 'evidence.png' }];
            record.fields['变更文档'] = [{ file_token: 'box_replacement', name: 'replacement.pdf' }];
            record.fields['调整请求唯一ID'] = request.clientMutationId;
            record.fields['调整请求指纹'] = 'f'.repeat(64);
            objectDeleted.add('InitialStorage_123');
          } else if (request.reason !== adjustmentRequest.reason) {
            throw { response: { status: 409, data: {} } };
          }
          return {
            success: true,
            clientMutationId: request.clientMutationId,
            record: {
              id: 'recChangeExact', bitableRecordId: 'recChangeExact',
              title: record.fields['变更简述'],
              startDate: initialRequest.plannedStartAt,
              endDate: initialRequest.plannedEndAt,
              actualStartDate: null, actualEndDate: null,
              plannedDelayStartDate: request.plannedDelayStartDate,
              plannedDelayEndDate: request.plannedDelayEndDate,
              level: initialRequest.level, type: initialRequest.changeType,
              progress: null, executor: null, buildings: initialRequest.buildings,
              riskSummary: initialRequest.riskSummary, isKey: false,
              createdAt: '2026-08-09T02:01:00.000Z',
              updatedAt: '2026-08-09T02:02:00.000Z',
            },
            message: '已同步',
          };
        },
        queryBaseByMarker: async (marker) => deleted || record?.fields['变更简述'] !== marker ? [] : [record],
        queryBaseByAdjustmentId: async (id) => deleted || record?.fields['调整请求唯一ID'] !== id ? [] : [record],
        getBaseRecordById: async (id) => !deleted && id === 'recChangeExact' ? record : null,
        getLocalChangeById: async (id) => id === 'recChangeExact' ? ({
          id: 'recChangeExact', bitableRecordId: 'recChangeExact',
          title: record.fields['变更简述'],
          updatedAt: '2026-08-09T02:01:30.000Z',
          adjustmentUpdatedAt: '2026-08-09T02:01:00.000Z',
          planDocuments: [{ fileToken: 'box_initial' }],
        }) : null,
        deleteBaseRecordById: async (id) => {
          if (id !== 'recChangeExact') throw new Error('wrong record');
          events.push('base-deleted'); deleted = true;
        },
        deleteAttachment: async ({ id }) => {
          events.push('object-delete:' + id); objectDeleted.add(id); return { missing: false };
        },
        isAttachmentAbsent: async ({ id }) => objectDeleted.has(id),
      };
      const value = await subject.runChangeAdjustmentSelfTest({}, deps);
      process.stdout.write(JSON.stringify({
        value,
        state,
        createPosts: initialRequest ? 3 : 0,
        adjusted: Boolean(adjustmentRequest),
        adjustmentExpectedUpdatedAt: adjustmentRequest?.expectedUpdatedAt,
        syncPolls,
        stateRecordIdAtFirstPoll,
        events,
      }));
    `);

    expect(result).toMatchObject({
      value: {
        ok: true,
        createReplayVerified: true,
        createTamperConflictVerified: true,
        adjustmentReplayVerified: true,
        adjustmentTamperConflictVerified: true,
        cleaned: true,
        residualCount: 0,
        objectResidualCount: 0,
      },
      state: null,
      adjusted: true,
      adjustmentExpectedUpdatedAt: '2026-08-09T02:01:00.000Z',
      syncPolls: 2,
      stateRecordIdAtFirstPoll: 'recChangeExact',
    });
    const events = result.events as string[];
    expect(events.filter((event) => event.startsWith('object-delete:'))).toEqual([
      'object-delete:ReplacementStorage_456',
      'object-delete:EvidenceStorage_789',
    ]);
    expect(events.indexOf('object-delete:EvidenceStorage_789')).toBeLessThan(
      events.indexOf('base-deleted'),
    );
    expect(events.at(-1)).toBe('state-removed');
    expect(events).toContain('submitter-field:writable');
    expect(JSON.stringify(result.value)).not.toContain('Test Submitter');
  });

  it('classifies attachment staging failure before Base create as definitely not written and removes recovery state', () => {
    const result = runScenario(`
      const uuids = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ];
      let state = null;
      let removed = 0;
      let baseDeletes = 0;
      let objectDeletes = 0;
      let markerQueries = 0;
      const stageError = new Error('stage-down');
      stageError.response = { status: 503, data: {} };
      try {
        await subject.runChangeAdjustmentSelfTest({}, {
          now: () => new Date('2026-08-09T10:00:00+08:00'),
          randomUUID: () => uuids.shift(),
          primeLocalApi: async () => undefined,
          fetchLocalPeople: async () => [{ supervisorText: 'Test Submitter' }],
          stageLargeScheme: async () => { throw stageError; },
          writeState: async (value) => { state = structuredClone(value); },
          removeState: async () => { state = null; removed += 1; },
          queryBaseByMarker: async () => { markerQueries += 1; return []; },
          queryBaseByAdjustmentId: async () => [],
          getBaseRecordById: async () => null,
          deleteBaseRecordById: async () => { baseDeletes += 1; },
          deleteAttachment: async () => { objectDeletes += 1; },
          isAttachmentAbsent: async () => true,
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          name: error.name,
          message: error.message,
          operation: error.selfTestOperation,
          state,
          removed,
          baseDeletes,
          objectDeletes,
          markerQueries,
        }));
      }
    `);

    expect(result).toEqual({
      name: 'Error',
      message: 'stage-down',
      operation: 'stage-initial-scheme',
      state: null,
      removed: 1,
      baseDeletes: 0,
      objectDeletes: 0,
      markerQueries: 2,
    });
  });

  it('refuses cleanup when the unique marker and exact record id do not match twice', () => {
    const result = runScenario(`
      const state = subject.validateChangeSelfTestState({
        version: 1,
        createMutationId: 'change-request-11111111-1111-4111-8111-111111111111',
        adjustmentMutationId: 'change-adjustment-22222222-2222-4222-8222-222222222222',
        recordId: 'recExpected',
        summaryMarker: 'CODEX-SELFTEST-CHANGE-1786200000000-deadbeef',
        adjustmentReasonMarker: 'CODEX-SELFTEST-CHANGE-ADJUST-1786200000000-feedface',
        disposition: 'adjustment-confirmed',
        cleanupPhase: 'none',
        attachments: [{ id: 'AttachmentStorage_123', ownerMutationId: 'change-request-11111111-1111-4111-8111-111111111111' }],
      });
      let deletes = 0;
      let objectDeletes = 0;
      let stateWrites = 0;
      try {
        await subject.cleanupChangeAdjustmentState(state, {
          queryBaseByMarker: async () => [{
            record_id: 'recOther',
            fields: {
              '变更简述': state.summaryMarker,
              '变更重要风险点（简述）': '自测清理校验：' + state.summaryMarker,
              '调整请求唯一ID': state.adjustmentMutationId,
              '延期理由': state.adjustmentReasonMarker,
            },
          }],
          queryBaseByAdjustmentId: async () => [],
          getBaseRecordById: async () => null,
          deleteBaseRecordById: async () => { deletes += 1; },
          deleteAttachment: async () => { objectDeletes += 1; },
          isAttachmentAbsent: async () => true,
          writeState: async () => { stateWrites += 1; },
          removeState: async () => undefined,
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          name: error.name, deletes, objectDeletes, stateWrites,
        }));
      }
    `);

    expect(result).toEqual({
      name: 'UnsafeChangeSelfTestCleanupError',
      deletes: 0,
      objectDeletes: 0,
      stateWrites: 0,
    });
  });

  it('keeps unknown-result state and objects when no strict Base readback exists yet', () => {
    const result = runScenario(`
      const state = subject.validateChangeSelfTestState({
        version: 1,
        createMutationId: 'change-request-33333333-3333-4333-8333-333333333333',
        adjustmentMutationId: 'change-adjustment-44444444-4444-4444-8444-444444444444',
        recordId: '',
        summaryMarker: 'CODEX-SELFTEST-CHANGE-1786200000000-cafebabe',
        adjustmentReasonMarker: 'CODEX-SELFTEST-CHANGE-ADJUST-1786200000000-facefeed',
        disposition: 'unknown-result',
        cleanupPhase: 'none',
        attachments: [{ id: 'AttachmentStorage_456', ownerMutationId: 'change-request-33333333-3333-4333-8333-333333333333' }],
      });
      let objectDeletes = 0;
      let removed = 0;
      try {
        await subject.cleanupChangeAdjustmentState(state, {
          queryBaseByMarker: async () => [],
          queryBaseByAdjustmentId: async () => [],
          getBaseRecordById: async () => null,
          deleteBaseRecordById: async () => undefined,
          deleteAttachment: async () => { objectDeletes += 1; },
          isAttachmentAbsent: async () => false,
          writeState: async () => undefined,
          removeState: async () => { removed += 1; },
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          name: error.name, objectDeletes, removed,
        }));
      }
    `);

    expect(result).toEqual({
      name: 'UnsafeChangeSelfTestCleanupError',
      objectDeletes: 0,
      removed: 0,
    });
  });

  it('cleanup-only recovery only finalizes an armed Base delete when every object is already absent', () => {
    const result = runScenario(`
      let state = subject.validateChangeSelfTestState({
        version: 1,
        createMutationId: 'change-request-77777777-7777-4777-8777-777777777777',
        adjustmentMutationId: 'change-adjustment-88888888-8888-4888-8888-888888888888',
        recordId: 'recAlreadyDeleted',
        summaryMarker: 'CODEX-SELFTEST-CHANGE-1786200000000-11223344',
        adjustmentReasonMarker: 'CODEX-SELFTEST-CHANGE-ADJUST-1786200000000-44332211',
        disposition: 'adjustment-confirmed',
        cleanupPhase: 'base-delete-armed',
        attachments: [{
          id: 'AttachmentStorage_789',
          ownerMutationId: 'change-adjustment-88888888-8888-4888-8888-888888888888',
        }],
      });
      const events = [];
      const value = await subject.cleanupChangeAdjustmentState(state, {
        primeLocalApi: async () => { events.push('session-primed'); },
        queryBaseByMarker: async () => [],
        queryBaseByAdjustmentId: async () => [],
        getBaseRecordById: async () => null,
        deleteBaseRecordById: async () => { throw new Error('must not repeat'); },
        deleteAttachment: async () => { throw new Error('must not delete an absent object'); },
        isAttachmentAbsent: async () => true,
        writeState: async (next) => {
          state = structuredClone(next);
          events.push('state:' + next.cleanupPhase);
        },
        removeState: async () => { events.push('state-removed'); },
      });
      process.stdout.write(JSON.stringify({ value, state, events }));
    `);

    expect(result).toMatchObject({
      value: {
        cleaned: true,
        residualCount: 0,
        objectResidualCount: 0,
      },
      state: { cleanupPhase: 'base-deleted' },
      events: ['session-primed', 'state:base-deleted', 'state-removed'],
    });
  });

  it('never deletes Base when object cleanup fails or remains visible', () => {
    const result = runScenario(`
      const state = subject.validateChangeSelfTestState({
        version: 1,
        createMutationId: 'change-request-99999999-9999-4999-8999-999999999999',
        adjustmentMutationId: 'change-adjustment-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        recordId: 'recObjectFirst',
        summaryMarker: 'CODEX-SELFTEST-CHANGE-1786200000000-abcdef12',
        adjustmentReasonMarker: 'CODEX-SELFTEST-CHANGE-ADJUST-1786200000000-1234abcd',
        disposition: 'adjustment-confirmed',
        cleanupPhase: 'none',
        attachments: [{
          id: 'AttachmentStorage_999',
          ownerMutationId: 'change-adjustment-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }],
      });
      let baseDeletes = 0;
      let objectDeletes = 0;
      const record = {
        record_id: state.recordId,
        fields: {},
      };
      record.fields['\u53d8\u66f4\u7b80\u8ff0'] = state.summaryMarker;
      record.fields['\u53d8\u66f4\u91cd\u8981\u98ce\u9669\u70b9\uff08\u7b80\u8ff0\uff09'] =
        '\u81ea\u6d4b\u6e05\u7406\u6821\u9a8c\uff1a' + state.summaryMarker;
      record.fields['\u8c03\u6574\u8bf7\u6c42\u552f\u4e00ID'] = state.adjustmentMutationId;
      record.fields['\u5ef6\u671f\u7406\u7531'] = state.adjustmentReasonMarker;
      try {
        await subject.cleanupChangeAdjustmentState(state, {
          queryBaseByMarker: async () => [record],
          queryBaseByAdjustmentId: async () => [record],
          getBaseRecordById: async () => record,
          deleteBaseRecordById: async () => { baseDeletes += 1; },
          deleteAttachment: async () => { objectDeletes += 1; },
          isAttachmentAbsent: async () => false,
          writeState: async () => undefined,
          removeState: async () => undefined,
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          name: error.name, baseDeletes, objectDeletes,
        }));
      }
    `);

    expect(result).toEqual({
      name: 'UnsafeChangeSelfTestCleanupError',
      baseDeletes: 0,
      objectDeletes: 1,
    });
  });

  it('uses a dedicated trusted bound-object cleanup endpoint instead of widening owner delete', () => {
    const source = scriptSource();
    expect(source).toContain(
      '/api/duty-schedules/change-adjustment/self-test/cleanup-bound-attachment',
    );
    expect(source).toContain("role: 'admin'");
    expect(source).toContain('x-change-self-test-cleanup-proof');
    expect(source).toContain('createChangeSelfTestCleanupProof');
  });

  it('rejects forged or PII-bearing state before any external cleanup', () => {
    const result = runScenario(`
      const valid = {
        version: 1,
        createMutationId: 'change-request-55555555-5555-4555-8555-555555555555',
        adjustmentMutationId: 'change-adjustment-66666666-6666-4666-8666-666666666666',
        recordId: 'recExact',
        summaryMarker: 'CODEX-SELFTEST-CHANGE-1786200000000-aabbccdd',
        adjustmentReasonMarker: 'CODEX-SELFTEST-CHANGE-ADJUST-1786200000000-ddccbbaa',
        disposition: 'create-confirmed',
        cleanupPhase: 'none',
        attachments: [],
      };
      const forged = [
        { ...valid, createMutationId: 'change-request-forged' },
        { ...valid, summaryMarker: '普通变更' },
        { ...valid, recordId: '../rec' },
        { ...valid, submitterName: '不应持久化的姓名' },
        { ...valid, attachments: [{ id: '../bad', ownerMutationId: valid.createMutationId }] },
      ];
      const names = [];
      for (const value of forged) {
        try { subject.validateChangeSelfTestState(value); }
        catch (error) { names.push(error.name); }
      }
      process.stdout.write(JSON.stringify(names));
    `);

    expect(result).toEqual(Array(5).fill('UnsafeChangeSelfTestCleanupError'));
  });

  it('maps failures to safe stage/code/ref output only', () => {
    const result = runScenario(`
      const error = new Error('Bearer secret-token app_secret=never-print');
      error.response = {
        status: 400,
        data: { message: '申请提交人“Sensitive Name”无法唯一匹配' },
      };
      const output = subject.buildSafeCliError(error, 'execute');
      process.stdout.write(JSON.stringify(output));
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
      reason: 'request-submitter',
      code: 'SELF_TEST_FAILED',
    });
    expect(result.safeRef).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('never-print');
    expect(JSON.stringify(result)).not.toContain('Sensitive Name');
  });

  it('classifies submitter data defects without exposing the submitted name', () => {
    const result = runScenario(`
      const error = new Error('request rejected');
      error.response = {
        status: 400,
        data: { message: '变更提交人“Sensitive Name”的飞书账号必须唯一' },
      };
      process.stdout.write(JSON.stringify(
        subject.buildSafeCliError(error, 'execute'),
      ));
    `);

    expect(result.reason).toBe('request-submitter-account-count');
    expect(JSON.stringify(result)).not.toContain('Sensitive Name');
  });

  it('classifies optimistic-lock conflicts without exposing the response', () => {
    const result = runScenario(`
      const error = new Error('request rejected');
      error.response = {
        status: 409,
        data: { message: '变更记录已被其他操作更新' },
      };
      process.stdout.write(JSON.stringify(
        subject.buildSafeCliError(error, 'execute'),
      ));
    `);

    expect(result.reason).toBe('adjustment-version-conflict');
    expect(JSON.stringify(result)).not.toContain('其他操作更新');
  });
});
