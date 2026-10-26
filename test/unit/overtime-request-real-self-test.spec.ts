import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
const scriptPath = resolve(root, 'scripts/self-test-overtime-request.mjs');
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
    },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function scriptSource(): string {
  return existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';
}

describe('overtime request real-data self-test', () => {
  it('uses local personnel/schedule APIs and the compiled shared impact calculator', () => {
    const source = scriptSource();

    expect(source).toContain('/api/bitable/person-profiles?scope=leave');
    expect(source).toContain('/api/monthly-schedules/');
    expect(source).toContain('../dist/shared/overtime-request-impact.js');
    expect(source).toContain('calculateOvertimeRequestImpact');
    expect(source).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(source).not.toMatch(
      /(?:app[_-]?token|app[_-]?secret|tenant_access_token|authorization|cookie)\s*[:=]\s*['"`][A-Za-z0-9._-]{16,}['"`]/i,
    );
    expect(source).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/i);
  });

  it('selects a future whole-hour candidate for a real scheduled person without overlap', () => {
    const result = runScenario(`
      const people = [{ supervisorText: '示例人员008' }];
      const schedules = [{
        recordId: 'recSchedule',
        scheduleDate: '2026-08-08',
        dutyStaffActual: ['示例人员008'],
        building: 'building_h',
        buildingText: 'H楼',
        team: 'shift_a',
        teamText: 'A班',
        shift: 'white',
        shiftText: '白班',
      }];
      const candidate = subject.selectOvertimeCandidate({
        people,
        schedules,
        now: new Date('2026-08-08T08:15:00+08:00'),
        calculateImpact: (_items, request) => {
          const hour = Number(request.startAt.slice(11, 13));
          const canSubmit = hour === 12;
          return {
            rawHours: 1,
            payableHours: 1,
            conflictingSchedules: canSubmit ? [] : [{ recordId: 'recSchedule' }],
            isWholeHour: true,
            invalidRangeReason: null,
            canSubmit,
          };
        },
      });
      process.stdout.write(JSON.stringify(candidate));
    `);

    expect(result).toMatchObject({
      staffName: '示例人员008',
      startAt: '2026-08-08T12:00:00+08:00',
      endAt: '2026-08-08T13:00:00+08:00',
    });
  });

  it('always selects an hour strictly later than now when now is already on an exact hour', () => {
    const result = runScenario(`
      const candidate = subject.selectOvertimeCandidate({
        people: [{ supervisorText: '示例人员008' }],
        schedules: [{
          recordId: 'recSchedule', scheduleDate: '2026-08-08',
          dutyStaffActual: ['示例人员008'], building: 'building_h',
          buildingText: 'H楼', team: 'shift_a', teamText: 'A班',
          shift: 'white', shiftText: '白班',
        }],
        now: new Date('2026-08-08T12:00:00+08:00'),
        calculateImpact: () => ({
          rawHours: 1, payableHours: 1, conflictingSchedules: [],
          isWholeHour: true, invalidRangeReason: null, canSubmit: true,
        }),
      });
      process.stdout.write(JSON.stringify(candidate));
    `);

    expect(result).toMatchObject({
      startAt: '2026-08-08T13:00:00+08:00',
      endAt: '2026-08-08T14:00:00+08:00',
    });
  });

  it('uses the personnel-table shift when calculating the authoritative candidate impact', () => {
    const result = runScenario(`
      const staffShifts = [];
      const candidate = subject.selectOvertimeCandidate({
        people: [{ supervisorText: '示例人员008', shift: '长白' }],
        schedules: [{
          recordId: 'recSchedule', scheduleDate: '2026-08-08',
          dutyStaffActual: ['示例人员008'], building: 'building_h',
          buildingText: 'H楼', team: 'long_white', teamText: '长白',
          shift: 'white', shiftText: '白班',
        }],
        now: new Date('2026-08-08T08:15:00+08:00'),
        calculateImpact: (_items, request) => {
          staffShifts.push(request.staffShift ?? null);
          return {
            rawHours: 1, payableHours: 1, conflictingSchedules: [],
            isWholeHour: true, invalidRangeReason: null, canSubmit: true,
          };
        },
      });
      process.stdout.write(JSON.stringify({ candidate, staffShifts }));
    `);

    expect(result).toMatchObject({
      candidate: { staffName: '示例人员008' },
      staffShifts: ['长白'],
    });
  });

  it('filters real-test candidates to one unique matching Feishu account', () => {
    const result = runScenario(`
      const eligibleStaffKeys = subject.extractEligibleOvertimeStaffKeys([
        { fields: { '姓名': 'Alpha', '员工姓名': [
          { id: 'ou_alpha_1', name: 'Alpha' },
          { id: 'ou_alpha_2', name: 'Alpha' },
        ] } },
        { fields: { '姓名': 'Beta', '员工姓名': [
          { id: 'ou_beta', name: 'Beta' },
        ] } },
        { fields: { '姓名': 'Gamma', '员工姓名': [
          { id: 'ou_gamma_1', name: 'Gamma' },
        ] } },
        { fields: { '姓名': 'Gamma', '员工姓名': [
          { id: 'ou_gamma_2', name: 'Gamma' },
        ] } },
        { fields: { '姓名': 'Delta', '员工姓名': [
          { id: 'ou_delta', name: 'Different' },
        ] } },
      ]);
      const candidate = subject.selectOvertimeCandidate({
        people: [
          { supervisorText: 'Alpha' },
          { supervisorText: 'Beta' },
          { supervisorText: 'Gamma' },
          { supervisorText: 'Delta' },
        ],
        schedules: [
          { dutyStaffActual: ['Alpha'] },
          { dutyStaffActual: ['Beta'] },
          { dutyStaffActual: ['Gamma'] },
          { dutyStaffActual: ['Delta'] },
        ],
        eligibleStaffKeys,
        now: new Date('2026-08-08T08:15:00+08:00'),
        calculateImpact: () => ({
          rawHours: 1,
          payableHours: 1,
          conflictingSchedules: [],
          isWholeHour: true,
          invalidRangeReason: null,
          canSubmit: true,
        }),
      });
      process.stdout.write(JSON.stringify({ eligibleStaffKeys, candidate }));
    `);

    expect(result).toMatchObject({
      eligibleStaffKeys: ['beta'],
      candidate: { staffName: 'Beta' },
    });
  });

  it('runs create, exact replay and tamper-conflict, then deletes only the exact record and proves zero residual', () => {
    const result = runScenario(`
      const impact = {
        rawHours: 1,
        payableHours: 1,
        conflictingSchedules: [],
        isWholeHour: true,
        invalidRangeReason: null,
        canSubmit: true,
      };
      let state = null;
      const stateSnapshots = [];
      let deleted = false;
      const posts = [];
      const queries = [];
      const exactReads = [];
      const exactDeletes = [];
      const removedStates = [];
      const screenshot = {
        absolutePath: 'C:/tmp/evidence.png',
        filename: 'evidence.png',
        mimeType: 'image/png',
        size: 4,
        buffer: Buffer.from([1, 2, 3, 4]),
      };
      const record = () => ({
        record_id: 'recOvertimeExact',
        fields: {
          '请求唯一ID': state.requestUniqueId,
          '请求指纹': state.fingerprint,
          '加班人员': [{ id: 'ou_test', name: posts[0].request.staffName }],
          '加班人员姓名': posts[0].request.staffName,
          '加班开始时间': Date.parse(posts[0].request.startAt),
          '加班结束时间': Date.parse(posts[0].request.endAt),
          '加班时长': impact.payableHours,
          '加班原因': state.reasonMarker,
          '加班举证': [{ file_token: 'box_test' }],
          '加班审批（示例人员001）': '',
          '加班审批（经理）': '',
        },
      });
      const deps = {
        now: () => new Date('2026-08-08T08:15:00+08:00'),
        randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
        fetchLocalPeople: async () => [{ supervisorText: '示例人员008' }],
        fetchLocalSchedules: async () => [{
          recordId: 'recSchedule', scheduleDate: '2026-08-08',
          dutyStaffActual: ['示例人员008'], building: 'building_h',
          buildingText: 'H楼', team: 'shift_a', teamText: 'A班',
          shift: 'white', shiftText: '白班',
        }],
        calculateImpact: () => impact,
        impactComparisonKey: (value) => JSON.stringify(value),
        postOvertimeRequest: async (request, file) => {
          posts.push({ request: structuredClone(request), filename: file.filename });
          const fingerprint = subject.computeOvertimeRequestFingerprint(
            request,
            file,
            JSON.stringify(request.expectedImpact),
          );
          if (posts.length === 3) {
            throw {
              response: {
                status: 409,
                data: { writeDisposition: 'definitely-not-written' },
              },
            };
          }
          return {
            success: true,
            created: posts.length === 1 ? 1 : 0,
            recordId: 'recOvertimeExact',
            clientMutationId: request.clientMutationId,
            requestFingerprint: fingerprint,
            impact,
          };
        },
        queryBaseByUniqueId: async (id) => {
          queries.push(id);
          return deleted ? [] : [record()];
        },
        getBaseRecordById: async (recordId) => {
          exactReads.push(recordId);
          return record();
        },
        deleteBaseRecordById: async (recordId) => {
          exactDeletes.push(recordId);
          deleted = true;
        },
        writeState: async (value) => {
          state = structuredClone(value);
          stateSnapshots.push(structuredClone(value));
        },
        removeState: async () => { removedStates.push(true); state = null; },
      };
      const value = await subject.runOvertimeRequestSelfTest(
        { screenshot },
        deps,
      );
      process.stdout.write(JSON.stringify({
        value,
        postIds: posts.map((item) => item.request.clientMutationId),
        postReasons: posts.map((item) => item.request.reason),
        queries,
        exactReads,
        exactDeletes,
        removedStates: removedStates.length,
        stateSnapshots,
        state,
      }));
    `);

    expect(result.value).toMatchObject({
      ok: true,
      created: 1,
      replayCreated: 0,
      tamperConflictVerified: true,
      residualCount: 0,
    });
    expect(result.postIds).toEqual([
      'overtime-request-123e4567-e89b-42d3-a456-426614174000',
      'overtime-request-123e4567-e89b-42d3-a456-426614174000',
      'overtime-request-123e4567-e89b-42d3-a456-426614174000',
    ]);
    expect(new Set(result.postReasons as string[]).size).toBe(2);
    expect(result.queries).toEqual([
      'overtime-request-123e4567-e89b-42d3-a456-426614174000',
      'overtime-request-123e4567-e89b-42d3-a456-426614174000',
      'overtime-request-123e4567-e89b-42d3-a456-426614174000',
    ]);
    expect(result.exactReads).toEqual(['recOvertimeExact']);
    expect(result.exactDeletes).toEqual(['recOvertimeExact']);
    expect(result.removedStates).toBe(1);
    expect(result.state).toBeNull();
    expect(result.stateSnapshots).toHaveLength(2);
    for (const snapshot of result.stateSnapshots as Array<
      Record<string, unknown>
    >) {
      expect(Object.keys(snapshot).sort()).toEqual(
        [
          'disposition',
          'fingerprint',
          'reasonMarker',
          'recordId',
          'requestUniqueId',
          'version',
        ].sort(),
      );
      expect(snapshot).not.toHaveProperty('staffName');
      expect(snapshot).not.toHaveProperty('startAt');
      expect(snapshot).not.toHaveProperty('endAt');
      expect(snapshot).not.toHaveProperty('payableHours');
    }
  });

  it('keeps the original mutation id and retained state when the first submit is unknown', () => {
    const result = runScenario(`
      const impact = {
        rawHours: 1, payableHours: 1, conflictingSchedules: [],
        isWholeHour: true, invalidRangeReason: null, canSubmit: true,
      };
      let state = null;
      let removeCalls = 0;
      const posts = [];
      const queryIds = [];
      try {
        await subject.runOvertimeRequestSelfTest(
          {
            screenshot: {
              absolutePath: 'C:/tmp/evidence.png', filename: 'evidence.png',
              mimeType: 'image/png', size: 1, buffer: Buffer.from([1]),
            },
          },
          {
            now: () => new Date('2026-08-08T18:15:00+08:00'),
            randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            fetchLocalPeople: async () => [{ supervisorText: '示例人员008' }],
            fetchLocalSchedules: async () => [{
              recordId: 'recSchedule', scheduleDate: '2026-08-08',
              dutyStaffActual: ['示例人员008'], building: 'building_h',
              buildingText: 'H楼', team: 'shift_a', teamText: 'A班',
              shift: 'white', shiftText: '白班',
            }],
            calculateImpact: () => impact,
            impactComparisonKey: (value) => JSON.stringify(value),
            postOvertimeRequest: async (request) => {
              posts.push(request.clientMutationId);
              throw {
                code: 'ETIMEDOUT',
                response: {
                  status: 503,
                  data: { writeDisposition: 'unknown-result' },
                },
              };
            },
            queryBaseByUniqueId: async (id) => { queryIds.push(id); return []; },
            getBaseRecordById: async () => { throw new Error('must not read'); },
            deleteBaseRecordById: async () => { throw new Error('must not delete'); },
            writeState: async (value) => { state = structuredClone(value); },
            removeState: async () => { removeCalls += 1; state = null; },
          },
        );
      } catch (error) {
        process.stdout.write(JSON.stringify({
          errorName: error.name,
          posts,
          queryIds,
          removeCalls,
          retainedState: state,
        }));
      }
    `);

    expect(result.errorName).toBe('AggregateError');
    expect(result.posts).toEqual([
      'overtime-request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
    expect(result.queryIds).toEqual([
      'overtime-request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
    expect(result.removeCalls).toBe(0);
    expect(result.retainedState).toMatchObject({
      requestUniqueId: 'overtime-request-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      disposition: 'unknown-result',
      recordId: '',
    });
    expect(
      Object.keys(result.retainedState as Record<string, unknown>).sort(),
    ).toEqual(
      [
        'disposition',
        'fingerprint',
        'reasonMarker',
        'recordId',
        'requestUniqueId',
        'version',
      ].sort(),
    );
  });

  it('refuses cleanup unless record id, unique id, reason marker and fingerprint all match twice', () => {
    const result = runScenario(`
      const state = {
        version: 1,
        requestUniqueId: 'overtime-request-11111111-1111-4111-8111-111111111111',
        fingerprint: '${'a'.repeat(64)}',
        recordId: 'recExact',
        reasonMarker: 'Codex真实验证-加班-1786200000000-deadbeef',
        disposition: 'confirmed',
      };
      const fields = {
        '请求唯一ID': state.requestUniqueId,
        '请求指纹': state.fingerprint,
        '加班原因': 'Codex真实验证-加班-WRONG',
      };
      let deleted = 0;
      let removed = 0;
      try {
        await subject.cleanupOvertimeRequestState(state, {
          queryBaseByUniqueId: async () => [{ record_id: 'recExact', fields }],
          getBaseRecordById: async () => ({ record_id: 'recExact', fields }),
          deleteBaseRecordById: async () => { deleted += 1; },
          writeState: async () => undefined,
          removeState: async () => { removed += 1; },
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          name: error.name,
          message: error.message,
          deleted,
          removed,
        }));
      }
    `);

    expect(result).toMatchObject({
      name: 'UnsafeOvertimeCleanupError',
      deleted: 0,
      removed: 0,
    });
    expect(String(result.message)).toContain('原因 marker');
  });

  it('still cleans the exact identified test record when Base automation changed non-identity fields', () => {
    const result = runScenario(`
      const state = {
        version: 1,
        requestUniqueId: 'overtime-request-22222222-2222-4222-8222-222222222222',
        fingerprint: '${'b'.repeat(64)}',
        recordId: 'recExact',
        reasonMarker: 'Codex真实验证-加班-1786200000000-feedface',
        disposition: 'confirmed',
      };
      let deleted = false;
      let removed = false;
      const record = {
        record_id: 'recExact',
        fields: {
          '请求唯一ID': state.requestUniqueId,
          '请求指纹': state.fingerprint,
          '加班原因': state.reasonMarker,
          '加班审批（示例人员001）': '同意',
        },
      };
      const value = await subject.cleanupOvertimeRequestState(state, {
        queryBaseByUniqueId: async () => deleted ? [] : [record],
        getBaseRecordById: async () => record,
        deleteBaseRecordById: async (recordId) => {
          if (recordId !== 'recExact') throw new Error('wrong record');
          deleted = true;
        },
        writeState: async () => undefined,
        removeState: async () => { removed = true; },
      });
      process.stdout.write(JSON.stringify({ value, deleted, removed }));
    `);

    expect(result).toMatchObject({
      value: { deleted: true, residualCount: 0 },
      deleted: true,
      removed: true,
    });
  });

  it('refuses every forged or PII-bearing cleanup state before querying or deleting Base', () => {
    const result = runScenario(`
      const valid = {
        version: 1,
        requestUniqueId: 'overtime-request-33333333-3333-4333-8333-333333333333',
        fingerprint: '${'c'.repeat(64)}',
        recordId: 'recExact',
        reasonMarker: 'Codex真实验证-加班-1786200000000-cafebabe',
        disposition: 'confirmed',
      };
      const forged = [
        { ...valid, requestUniqueId: 'overtime-request-forged' },
        { ...valid, requestUniqueId: valid.requestUniqueId + ' ' },
        { ...valid, reasonMarker: '普通加班申请' },
        { ...valid, disposition: ' confirmed' },
        { ...valid, fingerprint: 'not-64-hex' },
        { ...valid, staffName: '不应持久化的姓名' },
      ];
      let queryCalls = 0;
      let deleteCalls = 0;
      const errors = [];
      for (const state of forged) {
        try {
          await subject.cleanupOvertimeRequestState(state, {
            queryBaseByUniqueId: async () => { queryCalls += 1; return []; },
            getBaseRecordById: async () => { throw new Error('must not read'); },
            deleteBaseRecordById: async () => { deleteCalls += 1; },
            writeState: async () => undefined,
            removeState: async () => undefined,
          });
        } catch (error) {
          errors.push(error.name);
        }
      }
      process.stdout.write(JSON.stringify({ errors, queryCalls, deleteCalls }));
    `);

    expect(result).toEqual({
      errors: Array(6).fill('UnsafeOvertimeCleanupError'),
      queryCalls: 0,
      deleteCalls: 0,
    });
  });

  it('refuses an invalid adopted Base record id before state mutation or deletion', () => {
    const result = runScenario(`
      const state = {
        version: 1,
        requestUniqueId: 'overtime-request-44444444-4444-4444-8444-444444444444',
        fingerprint: '${'d'.repeat(64)}',
        recordId: '',
        reasonMarker: 'Codex真实验证-加班-1786200000000-facefeed',
        disposition: 'unknown-result',
      };
      const record = {
        record_id: '../recForged',
        fields: {
          '请求唯一ID': state.requestUniqueId,
          '请求指纹': state.fingerprint,
          '加班原因': state.reasonMarker,
        },
      };
      let stateWrites = 0;
      let exactReads = 0;
      let deletes = 0;
      try {
        await subject.cleanupOvertimeRequestState(state, {
          queryBaseByUniqueId: async () => [record],
          getBaseRecordById: async () => { exactReads += 1; return record; },
          deleteBaseRecordById: async () => { deletes += 1; },
          writeState: async () => { stateWrites += 1; },
          removeState: async () => undefined,
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          errorName: error.name, stateWrites, exactReads, deletes,
        }));
      }
    `);

    expect(result).toEqual({
      errorName: 'UnsafeOvertimeCleanupError',
      stateWrites: 0,
      exactReads: 0,
      deletes: 0,
    });
  });

  it('accepts a callable Axios-style client with get and post methods', () => {
    const result = runScenario(`
      const client = async () => undefined;
      client.get = async () => ({ data: {}, status: 200, headers: {} });
      client.post = async () => ({ data: { ok: true }, status: 200, headers: {} });
      const session = subject.createLoopbackApiSession({
        baseUrl: 'https://127.0.0.1:3001',
        client,
      });
      await session.prime();
      const response = await session.post('/api/duty-schedules/overtime-request', {});
      process.stdout.write(JSON.stringify(response.data));
    `);

    expect(result).toEqual({ ok: true });
  });

  it('primes CSRF through a safe same-loopback GET and scopes cookie/header to that session POST', () => {
    const result = runScenario(`
      const token = 'a'.repeat(43);
      const calls = [];
      const client = {
        get: async (path, config) => {
          calls.push({ method: 'GET', path, config });
          return {
            data: { ok: true },
            status: 200,
            headers: {
              'set-cookie': [
                'theme=light; Path=/',
                'suda-csrf-token=' + token + '; Path=/; Secure; SameSite=None',
              ],
            },
          };
        },
        post: async (path, data, config) => {
          calls.push({ method: 'POST', path, data, config });
          return { data: { ok: true }, status: 200, headers: {} };
        },
      };
      const session = subject.createLoopbackApiSession({
        baseUrl: 'https://127.0.0.1:3001',
        client,
      });
      await session.prime();
      await session.post('/api/duty-schedules/overtime-request', { test: true }, {
        headers: { 'content-type': 'multipart/form-data; boundary=test' },
      });
      const otherPosts = [];
      const otherSession = subject.createLoopbackApiSession({
        baseUrl: 'http://localhost:4000',
        client: {
          get: async () => ({ data: {}, status: 200, headers: {} }),
          post: async (path, data, config) => {
            otherPosts.push({ path, data, config });
            return { data: {}, status: 200, headers: {} };
          },
        },
      });
      await otherSession.prime();
      await otherSession.post('/api/duty-schedules/overtime-request', {});
      let crossOriginError = '';
      try {
        await session.post('https://open.feishu.cn/open-apis/test', {});
      } catch (error) {
        crossOriginError = error.name;
      }
      process.stdout.write(JSON.stringify({
        calls,
        otherHeaders: otherPosts[0].config.headers,
        crossOriginError,
      }));
    `);

    const calls = result.calls as Array<{
      method: string;
      path: string;
      config: { headers?: Record<string, string> };
    }>;
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/' },
      { method: 'POST', path: '/api/duty-schedules/overtime-request' },
    ]);
    expect(calls[1].config.headers).toMatchObject({
      Cookie: `suda-csrf-token=${'a'.repeat(43)}`,
      'x-suda-csrf-token': 'a'.repeat(43),
      'content-type': 'multipart/form-data; boundary=test',
    });
    expect(result.otherHeaders).toEqual({});
    expect(result.crossOriginError).toBe('TypeError');
  });

  it('allows development without a CSRF cookie but never invents or forwards one', () => {
    const result = runScenario(`
      const posts = [];
      const session = subject.createLoopbackApiSession({
        baseUrl: 'http://localhost:3001',
        client: {
          get: async () => ({ data: {}, status: 200, headers: {} }),
          post: async (path, data, config) => {
            posts.push({ path, data, config });
            return { data: {}, status: 200, headers: {} };
          },
        },
      });
      await session.prime();
      await session.post('/api/duty-schedules/overtime-request', {});
      process.stdout.write(JSON.stringify(posts[0]));
    `);

    expect(
      (result.config as { headers?: Record<string, string> }).headers,
    ).toEqual({});
  });

  it('maps top-level failures to stage/code/safeRef only without raw secrets or messages', () => {
    const result = runScenario(`
      const value = subject.buildSafeCliError(
        new Error('Bearer super-secret-token app_secret=do-not-print'),
        'execute',
      );
      process.stdout.write(JSON.stringify(value));
    `);

    expect(Object.keys(result).sort()).toEqual(['code', 'safeRef', 'stage']);
    expect(result).toMatchObject({
      stage: 'execute',
      code: 'SELF_TEST_FAILED',
    });
    expect(result.safeRef).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
    expect(JSON.stringify(result)).not.toContain('do-not-print');
    expect(JSON.stringify(result)).not.toContain('message');
  });

  it('adds a trusted execution phase without exposing the underlying failure', () => {
    const result = runScenario(`
      try {
        await subject.runOvertimeRequestSelfTest(
          {
            screenshot: {
              absolutePath: 'C:/tmp/evidence.png', filename: 'evidence.png',
              mimeType: 'image/png', size: 1, buffer: Buffer.from([1]),
            },
          },
          {
            now: () => new Date('2026-08-08T08:15:00+08:00'),
            randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
            primeLocalApi: async () => {
              throw new Error('Bearer phase-secret app_secret=never-print');
            },
          },
        );
      } catch (error) {
        process.stdout.write(JSON.stringify(
          subject.buildSafeCliError(error, 'execute'),
        ));
      }
    `);

    expect(Object.keys(result).sort()).toEqual([
      'code',
      'phase',
      'safeRef',
      'stage',
    ]);
    expect(result).toMatchObject({
      stage: 'execute',
      phase: 'prime',
      code: 'SELF_TEST_FAILED',
    });
    expect(result.safeRef).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(result)).not.toContain('phase-secret');
    expect(JSON.stringify(result)).not.toContain('never-print');
  });

  it('reports submit-first when the first local submission fails', () => {
    const result = runScenario(`
      const impact = {
        rawHours: 1, payableHours: 1, conflictingSchedules: [],
        isWholeHour: true, invalidRangeReason: null, canSubmit: true,
      };
      try {
        await subject.runOvertimeRequestSelfTest(
          {
            screenshot: {
              absolutePath: 'C:/tmp/evidence.png', filename: 'evidence.png',
              mimeType: 'image/png', size: 1, buffer: Buffer.from([1]),
            },
          },
          {
            now: () => new Date('2026-08-08T08:15:00+08:00'),
            randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
            primeLocalApi: async () => undefined,
            fetchLocalPeople: async () => [{ supervisorText: 'TestUser' }],
            fetchLocalSchedules: async () => [{
              recordId: 'recSchedule', scheduleDate: '2026-08-08',
              dutyStaffActual: ['TestUser'], building: 'building_h',
              buildingText: 'H', team: 'shift_a', teamText: 'A',
              shift: 'white', shiftText: 'white',
            }],
            calculateImpact: () => impact,
            impactComparisonKey: (value) => JSON.stringify(value),
            writeState: async () => undefined,
            postOvertimeRequest: async () => {
              throw {
                response: {
                  status: 400,
                  data: { writeDisposition: 'definitely-not-written' },
                },
              };
            },
            queryBaseByUniqueId: async () => [],
            removeState: async () => undefined,
          },
        );
      } catch (error) {
        process.stdout.write(JSON.stringify(
          subject.buildSafeCliError(error, 'execute'),
        ));
      }
    `);

    expect(result).toMatchObject({
      stage: 'execute',
      phase: 'submit-first',
      code: 'SELF_TEST_FAILED',
    });
    expect(Object.keys(result).sort()).toEqual([
      'code',
      'phase',
      'safeRef',
      'stage',
    ]);
  });

  it('defines every real-test operation as a safe phase enum', () => {
    const source = scriptSource();

    for (const phase of [
      'prime',
      'fetch-local',
      'fetch-eligible',
      'select-candidate',
      'state-persist',
      'submit-first',
      'verify-first',
      'replay',
      'tamper',
      'cleanup',
    ]) {
      expect(source).toContain(`'${phase}'`);
    }
  });

  it('does not trust a phase string supplied by an arbitrary error object', () => {
    const result = runScenario(`
      const error = new Error('ordinary failure');
      error.selfTestPhase = 'submit-first';
      process.stdout.write(JSON.stringify(
        subject.buildSafeCliError(error, 'execute'),
      ));
    `);

    expect(result).toEqual({
      stage: 'execute',
      code: 'SELF_TEST_FAILED',
      safeRef: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
  });

  it('uses only exact single-record deletion, keeps a cleanup-only state file, and emits no secrets', () => {
    const source = scriptSource();
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(source).toContain("command === 'cleanup-only'");
    expect(source).toContain(
      "'output/diagnostics/overtime-request-real-self-test-state.json'",
    );
    expect(source).toContain("const OVERTIME_TABLE_ID = 'tblf1bbd02a2b049'");
    expect(source).toContain(
      "const DEFAULT_OVERTIME_SOURCE_URL = 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE'",
    );
    expect(source).toContain(']) || DEFAULT_OVERTIME_SOURCE_URL');
    expect(source).toContain('deleteBaseRecordById(recordId)');
    expect(source).not.toMatch(/batch[_-]?delete|deleteMany|removeAll/i);
    expect(source).not.toContain('axios.defaults');
    expect(source).not.toContain('safeErrorMessage');
    expect(source).not.toMatch(
      /console\.(log|error)\([^\n]*(token|secret|cookie)/i,
    );
    expect(packageJson.scripts['self-test:overtime-request']).toContain(
      'scripts/self-test-overtime-request.mjs',
    );
    expect(packageJson.scripts['self-test:overtime-request']).toContain(
      'npm run build:server',
    );
  });
});
