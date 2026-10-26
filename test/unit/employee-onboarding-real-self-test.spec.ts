import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
const scriptPath = resolve(root, 'scripts/self-test-employee-onboarding.mjs');
const scriptUrl = pathToFileURL(scriptPath).href;

function runScenario(source: string): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import * as subject from ${JSON.stringify(scriptUrl)};\n${source}`,
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function source(): string {
  return existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';
}

describe('employee onboarding real self-test', () => {
  it('builds one valid, unique synthetic employee and an in-memory tiny PNG', () => {
    const result = runScenario(`
      const fixture = subject.createEmployeeOnboardingFixture({
        now: new Date('2026-08-16T12:34:56.789Z'),
        randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
      });
      process.stdout.write(JSON.stringify({
        request: fixture.request,
        nameHash: fixture.nameHash,
        photoBytes: [...fixture.photo.buffer.subarray(0, 8)],
        photoSize: fixture.photo.size,
      }));
    `);

    expect(result).toMatchObject({
      request: {
        clientMutationId:
          'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
        identityNumber: '110101199001010015',
        phone: '13800007889',
        entryDate: '2026-08-16',
        graduationDate: '2026-06-30',
        vehiclePlate: '苏FTEST1',
      },
      photoBytes: [137, 80, 78, 71, 13, 10, 26, 10],
    });
    expect(result.nameHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.photoSize).toEqual(expect.any(Number));
    expect((result.request as { name: string }).name).toMatch(
      /^CODEX-SELFTEST-EMPLOYEE-\d{13}-[0-9a-f]{8}$/u,
    );
  });

  it('accepts only the privacy-safe recovery-state whitelist', () => {
    const result = runScenario(`
      const state = subject.validateEmployeeOnboardingSelfTestState({
        version: 1,
        mutationId: 'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
        nameHash: '${'a'.repeat(64)}',
        recordId: 'recEmployee123',
        stage: 'confirmed',
        createdAt: '2026-08-16T12:34:56.789Z',
        updatedAt: '2026-08-16T12:35:56.789Z',
      });
      const forbidden = ['name', 'identityNumber', 'phone', 'token', 'buffer'];
      const rejected = forbidden.map((key) => {
        try {
          subject.validateEmployeeOnboardingSelfTestState({
            ...state,
            [key]: 'forbidden',
          });
          return false;
        } catch {
          return true;
        }
      });
      process.stdout.write(JSON.stringify({ state, rejected }));
    `);

    expect(Object.keys(result.state as object).sort()).toEqual(
      [
        'version',
        'mutationId',
        'nameHash',
        'recordId',
        'stage',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(result.rejected).toEqual([true, true, true, true, true]);
    expect(JSON.stringify(result.state)).not.toContain('110101199001010015');
    expect(JSON.stringify(result.state)).not.toContain('13800007889');
  });

  it('strictly verifies every business field and the one required ID photo', () => {
    const result = runScenario(`
      const fixture = subject.createEmployeeOnboardingFixture({
        now: new Date('2026-08-16T12:34:56.789Z'),
        randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
      });
      const fields = subject.expectedEmployeeOnboardingFields(fixture);
      const verified = subject.assertEmployeeOnboardingRecord(fields, fixture);
      let mismatchSafe = false;
      try {
        subject.assertEmployeeOnboardingRecord(
          { ...fields, '联系方式': '13800003294' },
          fixture,
        );
      } catch (error) {
        mismatchSafe = !String(error.message).includes(fixture.request.name)
          && !String(error.message).includes(fixture.request.identityNumber)
          && !String(error.message).includes(fixture.request.phone);
      }
      process.stdout.write(JSON.stringify({ verified, mismatchSafe }));
    `);

    expect(result).toEqual({ verified: true, mismatchSafe: true });
  });

  it('requires one valid ID-photo token and checks its available filename', () => {
    const result = runScenario(`
      const fixture = subject.createEmployeeOnboardingFixture({
        now: new Date('2026-08-16T12:34:56.789Z'),
        randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
      });
      const fields = subject.expectedEmployeeOnboardingFields(fixture);
      const named = {
        ...fields,
        '照片': [{ ...fields['照片'][0], name: fixture.photo.filename }],
      };
      const rejected = [];
      for (const candidate of [
        { ...named, '照片': [{ file_token: '' }] },
        {
          ...named,
          '照片': [{
            ...named['照片'][0],
            name: 'unexpected-photo.png',
          }],
        },
      ]) {
        try {
          subject.assertEmployeeOnboardingRecord(candidate, fixture);
          rejected.push(false);
        } catch (error) {
          rejected.push(
            !String(error.message).includes('synthetic-photo-attachment')
              && !String(error.message).includes('unexpected-photo.png'),
          );
        }
      }
      process.stdout.write(JSON.stringify({
        namedVerified: subject.assertEmployeeOnboardingRecord(named, fixture),
        rejected,
      }));
    `);

    expect(result).toEqual({
      namedVerified: true,
      rejected: [true, true],
    });
  });

  it('cleans up only the stored exact record id and confirms it is absent', () => {
    const result = runScenario(`
      const fixture = subject.createEmployeeOnboardingFixture({
        now: new Date('2026-08-16T12:34:56.789Z'),
        randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
      });
      const state = subject.validateEmployeeOnboardingSelfTestState({
        version: 1,
        mutationId: fixture.request.clientMutationId,
        nameHash: fixture.nameHash,
        recordId: 'recEmployee123',
        stage: 'confirmed',
        createdAt: '2026-08-16T12:34:56.789Z',
        updatedAt: '2026-08-16T12:35:56.789Z',
      });
      const calls = [];
      let deleted = false;
      const cleanup = await subject.cleanupEmployeeOnboardingState(state, {
        readRecordById: async (recordId) => {
          calls.push(['read', recordId]);
          return deleted ? null : subject.expectedEmployeeOnboardingFields(fixture);
        },
        deleteRecordById: async (recordId) => {
          calls.push(['delete', recordId]);
          deleted = true;
        },
        writeState: async (value) => calls.push(['write', value.stage]),
        removeState: async () => calls.push(['remove']),
      });
      process.stdout.write(JSON.stringify({ cleanup, calls }));
    `);

    expect(result.cleanup).toMatchObject({
      deleted: true,
      confirmedAbsent: true,
    });
    expect(result.calls).toEqual([
      ['read', 'recEmployee123'],
      ['write', 'cleanup-pending'],
      ['delete', 'recEmployee123'],
      ['write', 'cleanup-confirmed'],
      ['read', 'recEmployee123'],
      ['remove'],
    ]);
  });

  it('refuses deletion on an identity mismatch and preserves recovery state', () => {
    const result = runScenario(`
      const state = subject.validateEmployeeOnboardingSelfTestState({
        version: 1,
        mutationId: 'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
        nameHash: '${'a'.repeat(64)}',
        recordId: 'recEmployee123',
        stage: 'confirmed',
        createdAt: '2026-08-16T12:34:56.789Z',
        updatedAt: '2026-08-16T12:35:56.789Z',
      });
      let deleted = 0;
      let removed = 0;
      let rejected = false;
      try {
        await subject.cleanupEmployeeOnboardingState(state, {
          readRecordById: async () => ({ '姓名': 'different' }),
          deleteRecordById: async () => { deleted += 1; },
          writeState: async () => undefined,
          removeState: async () => { removed += 1; },
        });
      } catch {
        rejected = true;
      }
      process.stdout.write(JSON.stringify({ rejected, deleted, removed }));
    `);

    expect(result).toEqual({ rejected: true, deleted: 0, removed: 0 });
  });

  it('preserves confirmed recovery state when the first exact read is empty', () => {
    const result = runScenario(`
      const state = subject.validateEmployeeOnboardingSelfTestState({
        version: 1,
        mutationId: 'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
        nameHash: '${'a'.repeat(64)}',
        recordId: 'recEmployee123',
        stage: 'confirmed',
        createdAt: '2026-08-16T12:34:56.789Z',
        updatedAt: '2026-08-16T12:35:56.789Z',
      });
      let removed = 0;
      let rejected = false;
      try {
        await subject.cleanupEmployeeOnboardingState(state, {
          readRecordById: async () => null,
          deleteRecordById: async () => undefined,
          writeState: async () => undefined,
          removeState: async () => { removed += 1; },
        });
      } catch (error) {
        rejected = error.name === 'UnsafeEmployeeOnboardingCleanupError';
      }
      process.stdout.write(JSON.stringify({ rejected, removed }));
    `);

    expect(result).toEqual({ rejected: true, removed: 0 });
  });

  it('preserves cleanup-pending recovery state when its first exact read is empty', () => {
    const result = runScenario(`
      const state = subject.validateEmployeeOnboardingSelfTestState({
        version: 1,
        mutationId: 'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
        nameHash: '${'a'.repeat(64)}',
        recordId: 'recEmployee123',
        stage: 'cleanup-pending',
        createdAt: '2026-08-16T12:34:56.789Z',
        updatedAt: '2026-08-16T12:35:56.789Z',
      });
      let removed = 0;
      let rejected = false;
      try {
        await subject.cleanupEmployeeOnboardingState(state, {
          readRecordById: async () => null,
          deleteRecordById: async () => undefined,
          writeState: async () => undefined,
          removeState: async () => { removed += 1; },
        });
      } catch (error) {
        rejected = error.name === 'UnsafeEmployeeOnboardingCleanupError';
      }
      process.stdout.write(JSON.stringify({ rejected, removed }));
    `);

    expect(result).toEqual({ rejected: true, removed: 0 });
  });

  it('removes recovery state only after cleanup-confirmed and an exact null read', () => {
    const result = runScenario(`
      const state = subject.validateEmployeeOnboardingSelfTestState({
        version: 1,
        mutationId: 'employee-onboarding-123e4567-e89b-42d3-a456-426614174000',
        nameHash: '${'a'.repeat(64)}',
        recordId: 'recEmployee123',
        stage: 'cleanup-confirmed',
        createdAt: '2026-08-16T12:34:56.789Z',
        updatedAt: '2026-08-16T12:35:56.789Z',
      });
      let removed = 0;
      const cleanup = await subject.cleanupEmployeeOnboardingState(state, {
        readRecordById: async () => null,
        deleteRecordById: async () => undefined,
        writeState: async () => undefined,
        removeState: async () => { removed += 1; },
      });
      process.stdout.write(JSON.stringify({ cleanup, removed }));
    `);

    expect(result).toMatchObject({
      cleanup: {
        deleted: false,
        confirmedAbsent: true,
        alreadyClean: true,
      },
      removed: 1,
    });
  });

  it('runs exact cleanup from finally when post-submit verification fails', () => {
    const result = runScenario(`
      const calls = [];
      let readCount = 0;
      let deleted = false;
      let failed = false;
      try {
        await subject.runEmployeeOnboardingSelfTest({
          now: () => new Date('2026-08-16T12:34:56.789Z'),
          randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
          primeLocalApi: async () => calls.push('prime'),
          postEmployeeOnboarding: async (fixture) => ({
            success: true,
            syncStatus: 'confirmed',
            clientMutationId: fixture.request.clientMutationId,
            recordId: 'recEmployee123',
            createdAt: '2026-08-16T12:35:56.789Z',
          }),
          readRecordById: async () => {
            readCount += 1;
            if (deleted) return null;
            if (readCount === 1) return { '姓名': 'mismatch' };
            const fixture = subject.createEmployeeOnboardingFixture({
              now: new Date('2026-08-16T12:34:56.789Z'),
              randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
            });
            return subject.expectedEmployeeOnboardingFields(fixture);
          },
          deleteRecordById: async () => { deleted = true; calls.push('delete'); },
          writeState: async () => calls.push('write'),
          removeState: async () => calls.push('remove'),
        });
      } catch {
        failed = true;
      }
      process.stdout.write(JSON.stringify({ failed, deleted, calls }));
    `);

    expect(result).toMatchObject({ failed: true, deleted: true });
    expect(result.calls).toEqual(
      expect.arrayContaining(['prime', 'delete', 'remove']),
    );
  });

  it('obtains CSRF from the loopback document before posting multipart data', () => {
    const result = runScenario(`
      const seen = {};
      const session = subject.createLoopbackApiSession({
        baseUrl: 'https://127.0.0.1:3001',
        client: {
          get: async () => ({ headers: {
            'set-cookie': ['suda-csrf-token=${'a'.repeat(43)}; Path=/; HttpOnly'],
          } }),
          post: async (path, _data, config) => {
            seen.path = path;
            seen.headers = config.headers;
            return { data: { ok: true } };
          },
        },
      });
      await session.prime();
      await session.post('/api/bitable/employee-onboarding', {}, {
        headers: { 'content-type': 'multipart/form-data; boundary=test' },
      });
      process.stdout.write(JSON.stringify(seen));
    `);

    expect(result).toMatchObject({
      path: '/api/bitable/employee-onboarding',
      headers: {
        Cookie: `suda-csrf-token=${'a'.repeat(43)}`,
        'x-suda-csrf-token': 'a'.repeat(43),
      },
    });
  });

  it('disables redirects in both the local Axios client and loopback requests', () => {
    const result = runScenario(`
      const seen = {};
      const config = subject.createEmployeeOnboardingLocalAxiosConfig(
        'https://127.0.0.1:3001',
      );
      const session = subject.createLoopbackApiSession({
        baseUrl: 'https://127.0.0.1:3001',
        client: {
          get: async (_path, requestConfig) => {
            seen.getMaxRedirects = requestConfig.maxRedirects;
            return { headers: {
              'set-cookie': ['suda-csrf-token=${'a'.repeat(43)}; Path=/; HttpOnly'],
            } };
          },
          post: async (_path, _data, requestConfig) => {
            seen.postMaxRedirects = requestConfig.maxRedirects;
            return { data: { ok: true } };
          },
        },
      });
      await session.prime();
      await session.post('/api/bitable/employee-onboarding', {}, {});
      process.stdout.write(JSON.stringify({
        clientMaxRedirects: config.maxRedirects,
        ...seen,
      }));
    `);

    expect(result).toEqual({
      clientMaxRedirects: 0,
      getMaxRedirects: 0,
      postMaxRedirects: 0,
    });
  });

  it('wires safe run/cleanup commands without exposing PII or list deletion', () => {
    const script = source();
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(script).toContain("'/api/bitable/employee-onboarding'");
    expect(script).toContain("form.append('payload'");
    expect(script).toContain("form.append('photo'");
    expect(script).toContain('gateway.readRecord(recordId)');
    expect(script).toContain('gateway.deleteRecordForSelfTest(recordId)');
    expect(script).toContain("command === 'cleanup-only'");
    expect(script).not.toMatch(/query.*employee|list.*record|batch.*delete/iu);
    expect(script).not.toMatch(
      /console\.(?:log|error)\([^)]*(?:identityNumber|phone|token|buffer)/u,
    );
    expect(packageJson.scripts?.['self-test:employee-onboarding']).toContain(
      'scripts/self-test-employee-onboarding.mjs run',
    );
    expect(
      packageJson.scripts?.['self-test:employee-onboarding:cleanup'],
    ).toContain('scripts/self-test-employee-onboarding.mjs cleanup-only');
  });
});
