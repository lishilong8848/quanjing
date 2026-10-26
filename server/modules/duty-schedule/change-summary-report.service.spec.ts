import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

import type {
  ChangeSummaryReportAbandonRequest,
  ChangeSummaryReportCreateRequest,
  ChangeSummaryReportSyncPhase,
} from '../../../shared/change-summary-report';
import {
  buildChangeSummaryReportFingerprint,
  ChangeSummaryReportService,
  createChangeSummaryReportCleanupProof,
  scrubChangeRequestSelfTestLedgerDirectory,
  type ChangeSummaryReportCleanupPorts,
  type ChangeSummaryReportAbandonPorts,
  type ChangeSummaryReportSelfTestCleanupRequest,
  type ChangeSummaryReportExecutionPorts,
  type ChangeSummaryReportStoredFile,
} from './change-summary-report.service';

const MUTATION_ID =
  'change-summary-report-123e4567-e89b-42d3-a456-426614174000';
const CLEANUP_SECRET = Buffer.alloc(32, 7).toString('base64');
const CLEANUP_NOW = Date.parse('2026-08-11T13:00:00+08:00');
const SELF_TEST_MARKER = 'CODEX-SELFTEST-CHANGE-SUMMARY-1786424400000-deadbeef';
const CHANGE_REQUEST_MUTATION_ID =
  'change-request-523e4567-e89b-42d3-a456-426614174004';
const OWNER_FINGERPRINT = 'principal-fingerprint-owner-a';

jest.setTimeout(15_000);

const request = (
  patch: Partial<ChangeSummaryReportCreateRequest> = {},
): ChangeSummaryReportCreateRequest => ({
  clientMutationId: MUTATION_ID,
  submitterName: '彭怀响',
  changeRecordId: 'recChange12345678',
  summaryDocuments: [
    {
      name: '变更总结.pdf',
      type: 'application/pdf',
      size: 1024,
      objectStorage: {
        id: 'storage-summary-1',
        filePath: 'change-summary-reports/summary.pdf',
        bucketId: 'default-bucket',
        url: 'https://storage.example.test/change-summary-reports/summary.pdf',
      },
    },
  ],
  ...patch,
});

const storedFile = (): ChangeSummaryReportStoredFile => ({
  id: 'storage-summary-1',
  filePath: 'change-summary-reports/summary.pdf',
  bucketId: 'default-bucket',
  url: 'https://storage.example.test/change-summary-reports/summary.pdf',
  name: '变更总结.pdf',
  size: 1024,
  mimeType: 'application/pdf',
  sha256: 'a'.repeat(64),
});

describe('ChangeSummaryReportService', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'vnet-change-summary-report-'));
  });

  afterEach(async () => {
    await ChangeSummaryReportService.waitForAllIdle();
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it('persists accepted before returning and completes asynchronously in phase order', async () => {
    const phases: string[] = [];
    let completePhase!: () => void;
    const completedPhase = new Promise<void>((resolve) => {
      completePhase = resolve;
    });
    let scheduled: (() => void) | undefined;
    const service = new ChangeSummaryReportService({
      ledgerDir,
      onPhase: (phase) => {
        phases.push(phase);
        if (phase === 'completed') completePhase();
      },
      schedule: (callback) => {
        scheduled = callback;
      },
    });
    const ports = createPorts();

    const accepted = await service.enqueue(request(), ports);

    expect(accepted).toMatchObject({
      success: true,
      pendingSync: true,
      taskId: MUTATION_ID,
      clientMutationId: MUTATION_ID,
      changeRecordId: 'recChange12345678',
    });
    expect(ports.readChangeStrict).not.toHaveBeenCalled();
    const ledger = JSON.parse(
      await readFile(join(ledgerDir, `${MUTATION_ID}.json`), 'utf8'),
    ) as { phase: string };
    expect(ledger.phase).toBe('accepted');

    scheduled?.();
    await completedPhase;
    await service.waitForIdle();
    const completed = await service.getStatus(MUTATION_ID, ports);
    expect(completed).toMatchObject({
      taskId: MUTATION_ID,
      clientMutationId: MUTATION_ID,
      changeRecordId: 'recChange12345678',
      status: 'completed',
      phase: 'completed',
      summaryReportRecordId: 'recSummaryReport123456',
    });
    expect(phases).toEqual([
      'accepted',
      'validating',
      'uploading',
      'record-created',
      'readback-confirmed',
      'binding',
      'completed',
    ]);
    expect(ports.readReportStrict.mock.invocationCallOrder[0]).toBeLessThan(
      ports.bindStorageToRecord.mock.invocationCallOrder[0],
    );
    expect(ports.invalidateChangeCaches).toHaveBeenCalledTimes(1);
    expect(ports.bindStorageToRecord.mock.invocationCallOrder[0]).toBeLessThan(
      ports.invalidateChangeCaches.mock.invocationCallOrder[0],
    );
  });

  it('recovers an accepted task after restart when status is queried', async () => {
    const firstPorts = createPorts();
    const first = new ChangeSummaryReportService({
      ledgerDir,
      schedule: () => undefined,
    });
    await first.enqueue(request(), firstPorts);

    const restartedPorts = createPorts();
    const restarted = new ChangeSummaryReportService({ ledgerDir });
    const initial = await restarted.getStatus(MUTATION_ID, restartedPorts);
    expect(initial.status).toBe('pending');

    const completed = await waitForCompleted(restarted, restartedPorts);
    expect(completed.status).toBe('completed');
    expect(restartedPorts.createReport).toHaveBeenCalledTimes(1);
  });

  it('tracks an unexpected fire-and-forget rejection and drains without an unhandled promise', async () => {
    let scheduled: (() => void) | undefined;
    const service = new ChangeSummaryReportService({
      ledgerDir,
      schedule: (callback) => {
        scheduled = callback;
      },
    });
    const ports = createPorts();
    const executor = service as unknown as {
      executeWithChangeLock: (
        clientMutationId: string,
        executionPorts: ChangeSummaryReportExecutionPorts,
      ) => Promise<void>;
    };
    jest
      .spyOn(executor, 'executeWithChangeLock')
      .mockRejectedValueOnce(new Error('password=UNEXPECTED_PASSWORD'));

    await service.enqueue(request(), ports);
    scheduled?.();
    await expect(service.waitForIdle()).resolves.toBeUndefined();
    const failed = await service.getStatus(MUTATION_ID, ports);
    expect(failed).toMatchObject({ status: 'failed', phase: 'failed' });
    expect(failed.error).toBe('变更总结同步失败，请稍后重试');
    expect(failed.error).not.toContain('UNEXPECTED_PASSWORD');
  });

  it('uses the in-process ledger snapshot when the production directory disappears before execution', async () => {
    const phases: ChangeSummaryReportSyncPhase[] = [];
    let scheduled: (() => void) | undefined;
    const service = new ChangeSummaryReportService({
      ledgerDir,
      onPhase: (phase) => phases.push(phase),
      schedule: (callback) => {
        scheduled = callback;
      },
    });
    const ports = createPorts();
    ports.readChangeStrict.mockRejectedValueOnce(
      new Error('cookie=REMOVED_DIRECTORY_COOKIE'),
    );

    await service.enqueue(request(), ports);
    await rm(ledgerDir, { recursive: true, force: true });
    scheduled?.();
    await expect(service.waitForIdle()).resolves.toBeUndefined();
    const failed = await service.getStatus(MUTATION_ID, ports);
    expect(failed).toMatchObject({ status: 'failed', phase: 'failed' });
    expect(failed.error).toBe('变更总结同步失败，请稍后重试');
    expect(phases).toEqual(['accepted', 'validating', 'failed']);
  });

  it('reuses the same mutation and rejects a changed fingerprint', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir,
      schedule: () => undefined,
    });
    const ports = createPorts();
    const first = await service.enqueue(request(), ports);
    const second = await service.enqueue(request(), ports);
    expect(second).toEqual(first);

    await expect(
      service.enqueue(request({ submitterName: '另一人' }), ports),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('serializes concurrent enqueue calls for one mutation before accepting a fingerprint', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir,
      schedule: () => undefined,
    });
    const ports = createPorts();
    const outcomes = await Promise.allSettled([
      service.enqueue(request(), ports),
      service.enqueue(request({ submitterName: '另一人' }), ports),
    ]);

    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find(
      ({ status }) => status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
  });

  it('rejects a non-canonical status task id before resolving a ledger path', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    await expect(service.getStatus('../secret', createPorts())).rejects.toThrow(
      '变更总结任务标识无效',
    );
  });

  it('rejects a status ledger whose task id is not bound to the requested task', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir,
      schedule: () => undefined,
    });
    const ports = createPorts();
    await service.enqueue(request(), ports);
    const path = join(ledgerDir, `${MUTATION_ID}.json`);
    const ledger = JSON.parse(await readFile(path, 'utf8')) as {
      clientMutationId: string;
    };
    ledger.clientMutationId =
      'change-summary-report-423e4567-e89b-42d3-a456-426614174003';
    await writeFile(path, JSON.stringify(ledger), 'utf8');

    await expect(service.getStatus(MUTATION_ID, ports)).rejects.toThrow(
      '任务标识绑定不一致',
    );
  });

  it('allows the identical request to retry after a failed task', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockRejectedValueOnce(new Error('temporary read'));
    await service.enqueue(request(), ports);
    await waitForStatus(service, ports, 'failed');

    const retried = await service.enqueue(request(), ports);
    expect(retried).toMatchObject({ pendingSync: true });
    await expect(waitForCompleted(service, ports)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it.each([
    { submitterName: '示例人员004', expected: '提交人' },
    { progress: '进行中', expected: '已结束' },
    { progress: 'optUnknownProgress', expected: '未解析' },
    { level: 'optUnknownLevel', expected: '未解析' },
    { workflowStatus: 'optUnknownWorkflow', expected: '未解析' },
    { level: '超低', expected: '超低' },
    { workflowStatus: '退回', expected: '退回' },
    { workflowStatus: '审批返回', expected: '返回' },
    { workflowStatus: '已驳回', expected: '驳回' },
    { hasSummaryReport: true, expected: '已存在' },
    { plannedStartAt: '2026-05-31T23:59:59+08:00', expected: '2026年6月' },
  ])('fails an ineligible authoritative target: %o', async (target) => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockResolvedValue({
      recordId: 'recChange12345678',
      submitterName: '彭怀响',
      progress: '已结束',
      level: '中',
      workflowStatus: '通过',
      hasSummaryReport: false,
      plannedStartAt: '2026-06-01T00:00:00+08:00',
      plannedEndAt: '2026-06-01T18:00:00+08:00',
      ...target,
    });

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toContain(target.expected);
    expect(ports.uploadToBitable).not.toHaveBeenCalled();
    expect(ports.createReport).not.toHaveBeenCalled();
  });

  it('rejects an invalid authoritative date interval before upload', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockResolvedValue({
      ...(await ports.readChangeStrict('recChange12345678'))!,
      plannedEndAt: '2026-05-31T23:00:00+08:00',
    });

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toContain('计划结束时间');
    expect(ports.uploadToBitable).not.toHaveBeenCalled();
  });

  it.each([
    { plannedStartAt: '2026-06-31', plannedEndAt: '2026-07-01' },
    {
      plannedStartAt: '2026-06-01',
      plannedEndAt: '2026-06-31',
    },
    {
      plannedStartAt: '2026-06-01T09:00:00',
      plannedEndAt: '2026-06-01T18:00:00+08:00',
    },
  ])(
    'fails closed for an invalid or timezone-ambiguous date: %o',
    async (datePatch) => {
      const service = new ChangeSummaryReportService({ ledgerDir });
      const ports = createPorts();
      ports.readChangeStrict.mockResolvedValue({
        ...targetSnapshot(),
        ...datePatch,
      });

      await service.enqueue(request(), ports);
      const failed = await waitForStatus(service, ports, 'failed');
      expect(failed.error).toMatch(/时间|2026年6月/);
      expect(ports.uploadToBitable).not.toHaveBeenCalled();
    },
  );

  it('accepts valid epoch seconds and explicit-zone ISO dates', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockResolvedValue({
      ...targetSnapshot(),
      plannedStartAt: Date.parse('2026-06-01T09:00:00+08:00') / 1000,
      plannedEndAt: '2026-06-01T18:00:00+08:00',
    });

    await service.enqueue(request(), ports);
    await expect(waitForCompleted(service, ports)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('identifies non-leap February 29 as an invalid calendar date', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockResolvedValue({
      ...targetSnapshot(),
      plannedStartAt: '2026-02-29',
      plannedEndAt: '2026-06-01T18:00:00+08:00',
    });

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toContain('计划开始时间无效');
    expect(ports.uploadToBitable).not.toHaveBeenCalled();
  });

  it('keeps internal submitter whitespace significant after NFKC and trim', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockResolvedValue({
      ...targetSnapshot(),
      submitterName: '彭 怀响',
    });

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toContain('提交人');
    expect(failed.error).not.toContain('多维表');
    expect(ports.uploadToBitable).not.toHaveBeenCalled();
  });

  it('redacts and bounds an external error before persisting or returning it', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockRejectedValueOnce(
      new Error(
        `upstream local?foo=bar&trace=private https://example.test/api?token=secret-token\nAuthorization: Bearer bearer-secret SECRET_KEY=raw-secret ${'x'.repeat(500)}`,
      ),
    );

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toBe('变更总结同步失败，请稍后重试');
    expect(failed.error.length).toBeLessThanOrEqual(240);
    expect(failed.error).not.toMatch(
      /https?:|foo=bar|trace=private|secret-token|bearer-secret|raw-secret|[\r\n]/i,
    );
  });

  it('never persists generic credential key variants from an HttpException', async () => {
    const placeholders = [
      'TOKEN_PLACEHOLDER',
      'ACCESS_TOKEN_PLACEHOLDER',
      'REFRESH_TOKEN_PLACEHOLDER',
      'SESSION_PLACEHOLDER',
      'COOKIE_PLACEHOLDER',
      'PASSWORD_PLACEHOLDER',
      'PASSWD_PLACEHOLDER',
      'SECRET_PLACEHOLDER',
      'SECRET_ID_PLACEHOLDER',
      'SECRET_KEY_PLACEHOLDER',
      'API_KEY_PLACEHOLDER',
      'AUTH_PLACEHOLDER',
    ];
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readChangeStrict.mockRejectedValueOnce(
      new ServiceUnavailableException(
        [
          `token = "${placeholders[0]}"`,
          `access_token:'${placeholders[1]}'`,
          `refresh-token = ${placeholders[2]}`,
          `session : "${placeholders[3]}"`,
          `cookie= '${placeholders[4]}'`,
          `password :${placeholders[5]}`,
          `passwd = "${placeholders[6]}"`,
          `secret=${placeholders[7]}`,
          `SecretId : '${placeholders[8]}'`,
          `secretKey= "${placeholders[9]}"`,
          `apiKey : ${placeholders[10]}`,
          `AUTHORIZATION: Basic ${placeholders[11]}`,
        ].join(', '),
      ),
    );

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    const ledgerText = await readFile(
      join(ledgerDir, `${MUTATION_ID}.json`),
      'utf8',
    );
    expect(failed.error).toBe('变更总结同步失败，请稍后重试');
    for (const placeholder of placeholders) {
      expect(failed.error).not.toContain(placeholder);
      expect(ledgerText).not.toContain(placeholder);
    }
  });

  it.each([
    ['quoted JSON token', '{"token":"JSON_QUOTED_TOKEN"}', 'JSON_QUOTED_TOKEN'],
    [
      'quoted JSON password',
      '{"password":"JSON_PASSWORD_VALUE"}',
      'JSON_PASSWORD_VALUE',
    ],
    ['x-api-key header', 'x-api-key: HEADER_API_KEY', 'HEADER_API_KEY'],
    [
      'Set-Cookie header',
      'Set-Cookie: opaque=SET_COOKIE_VALUE; HttpOnly',
      'SET_COOKIE_VALUE',
    ],
  ])(
    'never returns or persists %s from an HttpException',
    async (_label, message, secret) => {
      const service = new ChangeSummaryReportService({ ledgerDir });
      const ports = createPorts();
      ports.readChangeStrict.mockRejectedValueOnce(
        new ServiceUnavailableException(message),
      );

      await service.enqueue(request(), ports);
      const failed = await waitForStatus(service, ports, 'failed');
      const ledgerText = await readFile(
        join(ledgerDir, `${MUTATION_ID}.json`),
        'utf8',
      );
      expect(failed.error).toBe('变更总结同步失败，请稍后重试');
      expect(failed.error).not.toContain(secret);
      expect(ledgerText).not.toContain(secret);
    },
  );

  it('never persists signed COS URL query or fragment in accepted and completed ledgers', async () => {
    const signedRequest = request({
      summaryDocuments: [
        {
          ...request().summaryDocuments[0],
          objectStorage: {
            ...request().summaryDocuments[0].objectStorage,
            url: 'https://storage.example.test/change-summary-reports/summary.pdf?SecretId=COS_SECRET_ID&q-signature=COS_SIGNATURE#COS_FRAGMENT',
          },
        },
      ],
    });
    let scheduled: (() => void) | undefined;
    const service = new ChangeSummaryReportService({
      ledgerDir,
      schedule: (callback) => {
        scheduled = callback;
      },
    });
    const ports = createPorts();
    ports.resolveOwnedStorage.mockResolvedValueOnce({
      ...storedFile(),
      url: signedRequest.summaryDocuments[0].objectStorage.url,
    });

    await service.enqueue(signedRequest, ports);
    const acceptedLedger = await readFile(
      join(ledgerDir, `${MUTATION_ID}.json`),
      'utf8',
    );
    expect(acceptedLedger).not.toMatch(
      /COS_SECRET_ID|COS_SIGNATURE|COS_FRAGMENT|SecretId|q-signature/,
    );

    scheduled?.();
    await waitForCompleted(service, ports);
    const completedLedger = await readFile(
      join(ledgerDir, `${MUTATION_ID}.json`),
      'utf8',
    );
    expect(completedLedger).not.toMatch(
      /COS_SECRET_ID|COS_SIGNATURE|COS_FRAGMENT|SecretId|q-signature/,
    );
    expect(completedLedger).toContain(
      'https://storage.example.test/change-summary-reports/summary.pdf',
    );
  });

  it('builds a business fingerprint independent of mutation id and signed URL query', () => {
    const first = request();
    const second = request({
      clientMutationId:
        'change-summary-report-223e4567-e89b-42d3-a456-426614174001',
      summaryDocuments: [
        {
          ...first.summaryDocuments[0],
          objectStorage: {
            ...first.summaryDocuments[0].objectStorage,
            url: 'https://storage.example.test/change-summary-reports/summary.pdf?sign=new-temporary-signature',
          },
        },
      ],
    });

    expect(buildChangeSummaryReportFingerprint(second)).toBe(
      buildChangeSummaryReportFingerprint(first),
    );
    expect(
      buildChangeSummaryReportFingerprint(
        request({
          summaryDocuments: [
            {
              ...first.summaryDocuments[0],
              objectStorage: {
                ...first.summaryDocuments[0].objectStorage,
                filePath: 'change-summary-reports/different.pdf',
              },
            },
          ],
        }),
      ),
    ).not.toBe(buildChangeSummaryReportFingerprint(first));
  });

  it('resolves an owned object after its signed download URL rotates', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir: '' });
    const ports = createPorts();
    ports.resolveOwnedStorage.mockResolvedValueOnce({
      ...storedFile(),
      url: 'https://new-cos-domain.example.test/temporary-download?sign=rotated',
    });

    await service.enqueue(request(), ports);

    await expect(waitForCompleted(service, ports)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('does not bind COS or complete when strict readback mismatches', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readReportStrict.mockResolvedValue({
      recordId: 'recSummaryReport123456',
      clientMutationId: MUTATION_ID,
      fingerprint: 'wrong',
      changeRecordId: 'recChange12345678',
      reportFileTokens: ['file-token-summary-1'],
    });

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.phase).toBe('failed');
    expect(ports.bindStorageToRecord).not.toHaveBeenCalled();
  });

  it('rejects a second mutation when the closing table already has a summary for the change', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.findReportByChangeRecordId.mockResolvedValue({
      ...persistedSnapshot(),
      clientMutationId:
        'change-summary-report-323e4567-e89b-42d3-a456-426614174002',
    });

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toContain('已存在变更总结');
    expect(ports.uploadToBitable).not.toHaveBeenCalled();
    expect(ports.createReport).not.toHaveBeenCalled();
  });

  it('reconciles an unknown create result by mutation without creating twice', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    let created = false;
    ports.findReportByMutationId.mockImplementation(async () =>
      created ? persistedSnapshot() : null,
    );
    ports.createReport.mockImplementation(async () => {
      created = true;
      throw new ServiceUnavailableException('unknown create result');
    });

    await service.enqueue(request(), ports);
    await waitForStatus(service, ports, 'failed');
    await service.enqueue(request(), ports);
    const completed = await waitForCompleted(service, ports);
    expect(completed.status).toBe('completed');
    expect(ports.createReport).toHaveBeenCalledTimes(1);
    expect(ports.bindStorageToRecord).toHaveBeenCalledTimes(1);
  });

  it.each(['create-result', 'readback', 'binding', 'cache'] as const)(
    'resumes the same mutation after %s interruption when Lookup already reports a summary',
    async (interruption) => {
      let persisted: ReturnType<typeof persistedSnapshot> | null = null;
      const first = new ChangeSummaryReportService({ ledgerDir });
      const ports = createPorts();
      ports.findReportByMutationId.mockImplementation(async () => persisted);
      ports.findReportByChangeRecordId.mockImplementation(
        async () => persisted,
      );
      ports.createReport.mockImplementation(async (input) => {
        persisted = {
          recordId: 'recSummaryReport123456',
          clientMutationId: input.clientMutationId,
          fingerprint: input.fingerprint,
          changeRecordId: input.changeRecordId,
          reportFileTokens: [...input.reportFileTokens],
        };
        if (interruption === 'create-result') {
          throw new ServiceUnavailableException('unknown create result');
        }
        return persisted.recordId;
      });
      ports.readReportStrict.mockImplementation(async () => {
        if (interruption === 'readback') {
          interruption = 'cache';
          throw new ServiceUnavailableException('temporary readback failure');
        }
        return persisted;
      });
      if (interruption === 'binding') {
        ports.bindStorageToRecord.mockRejectedValueOnce(
          new ServiceUnavailableException('temporary binding failure'),
        );
      }
      if (interruption === 'cache') {
        ports.invalidateChangeCaches.mockRejectedValueOnce(
          new ServiceUnavailableException('temporary cache failure'),
        );
      }

      await first.enqueue(request(), ports);
      await waitForStatus(first, ports, 'failed');
      ports.readChangeStrict.mockResolvedValue({
        ...targetSnapshot(),
        hasSummaryReport: true,
      });

      const restarted = new ChangeSummaryReportService({ ledgerDir });
      await restarted.enqueue(request(), ports);
      const completed = await waitForCompleted(restarted, ports);
      expect(completed.status).toBe('completed');
      expect(ports.createReport).toHaveBeenCalledTimes(1);
      expect(completed.summaryReportRecordId).toBe('recSummaryReport123456');
    },
  );

  it('rejects strict readback when the returned record id differs from the ledger record id', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.readReportStrict.mockImplementation(async () => ({
      ...persistedSnapshot(),
      recordId: 'recDifferentSummary123',
    }));

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toContain('严格回读');
    expect(ports.bindStorageToRecord).not.toHaveBeenCalled();
  });

  it('rejects an existing record whose attachment token would overwrite an uploaded ledger token', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.createReport.mockRejectedValueOnce(
      new ServiceUnavailableException('unknown create result'),
    );
    await service.enqueue(request(), ports);
    await waitForStatus(service, ports, 'failed');

    const external = {
      ...persistedSnapshot(),
      reportFileTokens: ['file-token-from-other-upload'],
    };
    ports.findReportByMutationId.mockResolvedValue(external);
    ports.readReportStrict.mockResolvedValue(external);
    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toContain('严格回读');
    expect(ports.bindStorageToRecord).not.toHaveBeenCalled();
  });

  it('rejects when mutation and relation queries return the same record id with different content', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    ports.findReportByMutationId.mockResolvedValue(persistedSnapshot());
    ports.findReportByChangeRecordId.mockResolvedValue({
      ...persistedSnapshot(),
      fingerprint: 'forged-relation-fingerprint',
    });
    ports.readReportStrict.mockResolvedValue(persistedSnapshot());

    await service.enqueue(request(), ports);
    const failed = await waitForStatus(service, ports, 'failed');
    expect(failed.error).toContain('严格回读');
    expect(ports.bindStorageToRecord).not.toHaveBeenCalled();
  });

  it('serializes different mutations for the same change record', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const service = new ChangeSummaryReportService({ ledgerDir: '' });
    const firstPorts = createPorts();
    firstPorts.readChangeStrict.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await firstGate;
      active -= 1;
      return targetSnapshot();
    });
    const secondPorts = createPorts();
    secondPorts.readChangeStrict.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return targetSnapshot();
    });

    await service.enqueue(request(), firstPorts);
    await service.enqueue(
      request({
        clientMutationId:
          'change-summary-report-223e4567-e89b-42d3-a456-426614174001',
      }),
      secondPorts,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondPorts.readChangeStrict).not.toHaveBeenCalled();
    releaseFirst();
    await waitForCompleted(service, firstPorts, MUTATION_ID);
    await waitForCompleted(
      service,
      secondPorts,
      'change-summary-report-223e4567-e89b-42d3-a456-426614174001',
    );
    expect(maxActive).toBe(1);
  });

  it('deletes an exactly bound self-test object once and rejects proof replay', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir: '',
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const executionPorts = createPorts();
    await service.enqueue(request(), executionPorts);
    await waitForCompleted(service, executionPorts);
    const cleanupPorts = createCleanupPorts();
    const cleanupRequest = selfTestCleanupRequest();
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await expect(
      service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
    ).resolves.toEqual({
      success: true,
      objectId: 'storage-summary-1',
      missing: false,
    });
    expect(
      cleanupPorts.deleteBoundStorageForTrustedSelfTest,
    ).toHaveBeenCalledWith({
      id: 'storage-summary-1',
      recordId: 'recSummaryReport123456',
      fileToken: 'file-token-summary-1',
      ownerMutationId: MUTATION_ID,
    });
    await expect(
      service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
    ).rejects.toThrow('重复使用');
    expect(
      cleanupPorts.deleteBoundStorageForTrustedSelfTest,
    ).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'summary marker',
      { summaryMarker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786424400000-cafebabe' },
    ],
    ['submitter', { submitterName: '其他提交人' }],
    ['file token', { fileToken: 'file-token-other' }],
  ])('binds cleanup proof to %s', async (_label, patch) => {
    const service = new ChangeSummaryReportService({
      ledgerDir: '',
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const cleanupPorts = createCleanupPorts();
    const original = selfTestCleanupRequest();
    const proof = createChangeSummaryReportCleanupProof(
      original,
      CLEANUP_SECRET,
    );

    await expect(
      service.cleanupBoundAttachment(
        { ...original, ...patch },
        proof,
        cleanupPorts,
      ),
    ).rejects.toThrow('签名无效');
    expect(cleanupPorts.readChangeStrict).not.toHaveBeenCalled();
    expect(
      cleanupPorts.deleteBoundStorageForTrustedSelfTest,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ['marker', { title: '生产变更标题' }, '自测标记'],
    ['submitter', { submitterName: '其他提交人' }, '提交人'],
  ])(
    'rejects cleanup when authoritative main %s drifts',
    async (_label, targetPatch, expected) => {
      const service = new ChangeSummaryReportService({
        ledgerDir: '',
        cleanupSecret: CLEANUP_SECRET,
        now: () => new Date(CLEANUP_NOW),
      });
      const executionPorts = createPorts();
      await service.enqueue(request(), executionPorts);
      await waitForCompleted(service, executionPorts);
      const cleanupPorts = createCleanupPorts();
      cleanupPorts.readChangeStrict.mockResolvedValueOnce({
        ...targetSnapshot(),
        ...targetPatch,
      });
      const cleanupRequest = selfTestCleanupRequest();
      const proof = createChangeSummaryReportCleanupProof(
        cleanupRequest,
        CLEANUP_SECRET,
      );

      await expect(
        service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
      ).rejects.toThrow(expected);
      expect(
        cleanupPorts.deleteBoundStorageForTrustedSelfTest,
      ).not.toHaveBeenCalled();
    },
  );

  it('scrubs the completed summary ledger to a non-sensitive tombstone only after exact cleanup', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir,
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const executionPorts = createPorts();
    await service.enqueue(request(), executionPorts);
    await waitForCompleted(service, executionPorts);
    const cleanupPorts = createCleanupPorts();
    const cleanupRequest = selfTestCleanupRequest();
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts);

    const files = await readdir(ledgerDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^self-test-cleaned-[0-9a-f]{64}\.json$/);
    const residual = await readFile(join(ledgerDir, files[0]), 'utf8');
    expect(residual).toContain('self-test-cleaned');
    expect(residual).not.toMatch(
      /彭怀响|storage-summary|recChange|recSummary|file-token|change-summary-report-/,
    );
    expect(cleanupPorts.scrubChangeRequestSelfTestLedger).toHaveBeenCalledWith({
      changeRequestMutationId: CHANGE_REQUEST_MUTATION_ID,
      changeRecordId: 'recChange12345678',
      summaryMarker: SELF_TEST_MARKER,
      submitterName: '彭怀响',
    });
  });

  it('fails closed when the first trusted binding lookup is absent', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir,
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const executionPorts = createPorts();
    await service.enqueue(request(), executionPorts);
    await waitForCompleted(service, executionPorts);
    const cleanupPorts = createCleanupPorts();
    cleanupPorts.findBoundStorageForTrustedSelfTest.mockResolvedValue(null);
    const cleanupRequest = selfTestCleanupRequest();
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await expect(
      service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
    ).rejects.toThrow('可信绑定');
    expect(
      cleanupPorts.deleteBoundStorageForTrustedSelfTest,
    ).not.toHaveBeenCalled();
    expect(
      cleanupPorts.scrubChangeRequestSelfTestLedger,
    ).not.toHaveBeenCalled();
    const files = await readdir(ledgerDir);
    expect(files).toContain(`${MUTATION_ID}.json`);
    expect(files.some((name) => name.startsWith('self-test-cleaned-'))).toBe(
      false,
    );
  });

  it('removes only exact summary ledger temp and backup files after tombstoning', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir,
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const executionPorts = createPorts();
    await service.enqueue(request(), executionPorts);
    await waitForCompleted(service, executionPorts);
    const exactTemp = `${MUTATION_ID}.json.4242.a1b2c3d4e5f6.tmp`;
    const exactBackup = `${MUTATION_ID}.json.bak`;
    const similarTemp = `${MUTATION_ID}0.json.4242.a1b2c3d4e5f6.tmp`;
    await writeFile(join(ledgerDir, exactTemp), 'sensitive exact temp');
    await writeFile(join(ledgerDir, exactBackup), 'sensitive exact backup');
    await writeFile(join(ledgerDir, similarTemp), 'unrelated mutation');
    const cleanupPorts = createCleanupPorts();
    const cleanupRequest = selfTestCleanupRequest();
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts);

    const files = await readdir(ledgerDir);
    expect(files).not.toContain(exactTemp);
    expect(files).not.toContain(exactBackup);
    expect(files).toContain(similarTemp);
    expect(
      files.some((name) => /^self-test-cleaned-[0-9a-f]{64}\.json$/.test(name)),
    ).toBe(true);
  });

  it('never abandons a confirmed completed summary', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir: '' });
    const executionPorts = createPorts();
    await service.enqueue(request(), executionPorts, OWNER_FINGERPRINT);
    await waitForCompleted(service, executionPorts);
    const abandonPorts = createAbandonPorts();

    await expect(
      service.abandon(abandonRequest(), OWNER_FINGERPRINT, abandonPorts),
    ).resolves.toMatchObject({
      canAbandon: false,
      abandoned: false,
      phase: 'completed',
    });
    expect(abandonPorts.deleteOwnedStorage).not.toHaveBeenCalled();
    expect(abandonPorts.deleteBoundStorage).not.toHaveBeenCalled();
    expect(abandonPorts.deleteReportStrict).not.toHaveBeenCalled();
  });

  it.each(['before-bind', 'after-bind'] as const)(
    'compensates a failed formal record %s and makes repeated abandon idempotent',
    async (failurePoint) => {
      const service = new ChangeSummaryReportService({ ledgerDir: '' });
      const executionPorts = createPorts();
      if (failurePoint === 'before-bind') {
        executionPorts.bindStorageToRecord.mockRejectedValueOnce(
          new ServiceUnavailableException('bind failed'),
        );
      } else {
        executionPorts.invalidateChangeCaches.mockRejectedValueOnce(
          new ServiceUnavailableException('cache failed'),
        );
      }
      await service.enqueue(request(), executionPorts, OWNER_FINGERPRINT);
      await waitForStatus(service, executionPorts, 'failed');
      const abandonPorts = createAbandonPorts();
      if (failurePoint === 'before-bind') {
        abandonPorts.findBoundStorage.mockResolvedValue(null);
      }

      const first = await service.abandon(
        abandonRequest(),
        OWNER_FINGERPRINT,
        abandonPorts,
      );
      const second = await service.abandon(
        abandonRequest(),
        OWNER_FINGERPRINT,
        abandonPorts,
      );

      expect(first).toMatchObject({
        canAbandon: true,
        abandoned: true,
        phase: 'abandoned',
      });
      expect(second).toMatchObject({
        canAbandon: true,
        abandoned: true,
        phase: 'abandoned',
      });
      expect(abandonPorts.deleteReportStrict).toHaveBeenCalledTimes(1);
      if (failurePoint === 'before-bind') {
        expect(abandonPorts.deleteOwnedStorage).toHaveBeenCalledTimes(1);
        expect(abandonPorts.deleteBoundStorage).not.toHaveBeenCalled();
      } else {
        expect(abandonPorts.deleteBoundStorage).toHaveBeenCalledTimes(1);
        expect(abandonPorts.deleteOwnedStorage).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps a recoverable cleanup-partial checkpoint and resumes without deleting storage twice', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const executionPorts = createPorts();
    executionPorts.bindStorageToRecord.mockRejectedValueOnce(
      new ServiceUnavailableException('bind failed'),
    );
    await service.enqueue(request(), executionPorts, OWNER_FINGERPRINT);
    await waitForStatus(service, executionPorts, 'failed');
    const abandonPorts = createAbandonPorts();
    abandonPorts.findBoundStorage.mockResolvedValue(null);
    abandonPorts.deleteReportStrict.mockRejectedValueOnce(
      new ServiceUnavailableException('temporary delete failure'),
    );

    const partial = await service.abandon(
      abandonRequest(),
      OWNER_FINGERPRINT,
      abandonPorts,
    );
    const completed = await service.abandon(
      abandonRequest(),
      OWNER_FINGERPRINT,
      abandonPorts,
    );

    expect(partial).toMatchObject({
      canAbandon: true,
      abandoned: false,
      phase: 'cleanup-partial',
    });
    expect(completed).toMatchObject({ abandoned: true, phase: 'abandoned' });
    expect(abandonPorts.deleteOwnedStorage).toHaveBeenCalledTimes(1);
    expect(abandonPorts.deleteReportStrict).toHaveBeenCalledTimes(2);
  });

  it('rejects abandon from a different authenticated principal before external reads', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const executionPorts = createPorts();
    executionPorts.readChangeStrict.mockRejectedValueOnce(
      new ServiceUnavailableException('validation failed'),
    );
    await service.enqueue(request(), executionPorts, OWNER_FINGERPRINT);
    await waitForStatus(service, executionPorts, 'failed');
    const abandonPorts = createAbandonPorts();

    await expect(
      service.abandon(
        abandonRequest(),
        'principal-fingerprint-owner-b',
        abandonPorts,
      ),
    ).rejects.toThrow('提交会话');
    expect(abandonPorts.readReportStrict).not.toHaveBeenCalled();
    expect(abandonPorts.findBoundStorage).not.toHaveBeenCalled();
  });

  it('rejects task status from a different authenticated principal', async () => {
    const service = new ChangeSummaryReportService({ ledgerDir });
    const ports = createPorts();
    await service.enqueue(request(), ports, OWNER_FINGERPRINT);

    await expect(
      service.getStatus(MUTATION_ID, ports, 'principal-fingerprint-owner-b'),
    ).rejects.toThrow('提交会话');
  });

  it('scrubs only the exact self-test change-request ledger and is idempotent', async () => {
    const directory = join(ledgerDir, 'change-request');
    await mkdir(directory, { recursive: true });
    await writeChangeRequestSelfTestLedger(directory);
    const unrelated = 'change-request-623e4567-e89b-42d3-a456-426614174005';
    await writeFile(
      join(directory, `${unrelated}.sha256`),
      `${'b'.repeat(64)}\n`,
    );

    const first = await scrubChangeRequestSelfTestLedgerDirectory({
      ledgerDir: directory,
      changeRequestMutationId: CHANGE_REQUEST_MUTATION_ID,
      changeRecordId: 'recChange12345678',
      summaryMarker: SELF_TEST_MARKER,
      submitterName: '彭怀响',
      expectedObjectIds: ['storage-change-1'],
    });
    const second = await scrubChangeRequestSelfTestLedgerDirectory({
      ledgerDir: directory,
      changeRequestMutationId: CHANGE_REQUEST_MUTATION_ID,
      changeRecordId: 'recChange12345678',
      summaryMarker: SELF_TEST_MARKER,
      submitterName: '彭怀响',
      expectedObjectIds: ['storage-change-1'],
    });

    expect(first).toEqual({ alreadyScrubbed: false });
    expect(second).toEqual({ alreadyScrubbed: true });
    const files = await readdir(directory);
    expect(files).toContain(`${unrelated}.sha256`);
    expect(
      files.some((name) => name.startsWith(`${CHANGE_REQUEST_MUTATION_ID}.`)),
    ).toBe(false);
    const tombstoneName = files.find((name) =>
      /^self-test-cleaned-[0-9a-f]{64}\.json$/.test(name),
    );
    expect(tombstoneName).toBeTruthy();
    const residual = await readFile(join(directory, tombstoneName!), 'utf8');
    expect(residual).not.toMatch(
      /彭怀响|storage-change|recChange|file-token|CODEX-SELFTEST|change-request-/,
    );
  });

  it.each([
    ['missing', []],
    ['drifting', ['storage-change-other']],
    ['duplicated', ['storage-change-1', 'storage-change-1']],
  ])(
    'refuses to scrub a change-request ledger with %s object ids',
    async (_label, expectedObjectIds) => {
      const directory = join(ledgerDir, 'change-request-object-drift');
      await mkdir(directory, { recursive: true });
      await writeChangeRequestSelfTestLedger(directory);

      await expect(
        scrubChangeRequestSelfTestLedgerDirectory({
          ledgerDir: directory,
          changeRequestMutationId: CHANGE_REQUEST_MUTATION_ID,
          changeRecordId: 'recChange12345678',
          summaryMarker: SELF_TEST_MARKER,
          submitterName: '彭怀响',
          expectedObjectIds,
        }),
      ).rejects.toThrow(/(?:附件|对象).*\u4e0d一致|请求无效/);
      const files = await readdir(directory);
      expect(files).toContain(`${CHANGE_REQUEST_MUTATION_ID}.completed.json`);
      expect(files.some((name) => name.startsWith('self-test-cleaned-'))).toBe(
        false,
      );
    },
  );

  it('resumes an allowlisted half-deleted change-request ledger after its tombstone is durable', async () => {
    const directory = join(ledgerDir, 'change-request-half-deleted');
    await mkdir(directory, { recursive: true });
    await writeChangeRequestSelfTestLedger(directory);
    const mutationHash = createHash('sha256')
      .update(CHANGE_REQUEST_MUTATION_ID)
      .digest('hex');
    await writeFile(
      join(directory, `self-test-cleaned-${mutationHash}.json`),
      JSON.stringify({
        version: 1,
        state: 'self-test-cleaned',
        mutationHash,
        cleanedAt: new Date(CLEANUP_NOW).toISOString(),
      }),
    );
    await rm(join(directory, `${CHANGE_REQUEST_MUTATION_ID}.sha256`));
    await rm(join(directory, `${CHANGE_REQUEST_MUTATION_ID}.record.json`));
    const unrelated = 'change-request-723e4567-e89b-42d3-a456-426614174006';
    await writeFile(join(directory, `${unrelated}.completed.json`), '{}');

    await expect(
      scrubChangeRequestSelfTestLedgerDirectory({
        ledgerDir: directory,
        changeRequestMutationId: CHANGE_REQUEST_MUTATION_ID,
        changeRecordId: 'recChange12345678',
        summaryMarker: SELF_TEST_MARKER,
        submitterName: '彭怀响',
      }),
    ).resolves.toEqual({ alreadyScrubbed: true });
    const files = await readdir(directory);
    expect(
      files.some((name) => name.startsWith(`${CHANGE_REQUEST_MUTATION_ID}.`)),
    ).toBe(false);
    expect(files).toContain(`${unrelated}.completed.json`);
  });

  it.each([
    ['record id', { changeRecordId: 'recOtherChange12345' }],
    [
      'marker',
      { summaryMarker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786424400000-cafebabe' },
    ],
    ['submitter', { submitterName: '其他提交人' }],
  ])(
    'refuses to scrub a change-request ledger with drifting %s',
    async (_label, patch) => {
      const directory = join(ledgerDir, 'change-request');
      await mkdir(directory, { recursive: true });
      await writeChangeRequestSelfTestLedger(directory);

      await expect(
        scrubChangeRequestSelfTestLedgerDirectory({
          ledgerDir: directory,
          changeRequestMutationId: CHANGE_REQUEST_MUTATION_ID,
          changeRecordId: 'recChange12345678',
          summaryMarker: SELF_TEST_MARKER,
          submitterName: '彭怀响',
          ...patch,
        }),
      ).rejects.toThrow('身份不一致');
      const files = await readdir(directory);
      expect(files).toContain(`${CHANGE_REQUEST_MUTATION_ID}.completed.json`);
    },
  );

  it.each([
    {
      patch: { changeRecordId: 'recOtherChange12345' },
      message: '主变更记录',
    },
    {
      patch: {
        clientMutationId:
          'change-summary-report-423e4567-e89b-42d3-a456-426614174003',
      },
      message: '请求标识',
    },
  ])('rejects a cleanup identity mismatch: %o', async ({ patch, message }) => {
    const service = new ChangeSummaryReportService({
      ledgerDir: '',
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const cleanupPorts = createCleanupPorts();
    const cleanupRequest = selfTestCleanupRequest(patch);
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await expect(
      service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
    ).rejects.toThrow(message);
    expect(
      cleanupPorts.deleteBoundStorageForTrustedSelfTest,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundPatch: { boundRecordId: 'recOtherSummary12345' },
      message: '绑定关系',
    },
    {
      boundPatch: {
        ownerMutationId:
          'change-summary-report-423e4567-e89b-42d3-a456-426614174003',
      },
      message: '绑定关系',
    },
    {
      boundPatch: { fileToken: 'file-token-not-in-closing-record' },
      message: '附件令牌',
    },
  ])(
    'rejects cleanup before COS deletion when binding identity mismatches: %o',
    async ({ boundPatch, message }) => {
      const service = new ChangeSummaryReportService({
        ledgerDir: '',
        cleanupSecret: CLEANUP_SECRET,
        now: () => new Date(CLEANUP_NOW),
      });
      const executionPorts = createPorts();
      await service.enqueue(request(), executionPorts);
      await waitForCompleted(service, executionPorts);
      const cleanupPorts = createCleanupPorts();
      cleanupPorts.findBoundStorageForTrustedSelfTest.mockResolvedValueOnce({
        id: 'storage-summary-1',
        boundRecordId: 'recSummaryReport123456',
        fileToken: 'file-token-summary-1',
        ownerMutationId: MUTATION_ID,
        ...boundPatch,
      });
      const cleanupRequest = selfTestCleanupRequest();
      const proof = createChangeSummaryReportCleanupProof(
        cleanupRequest,
        CLEANUP_SECRET,
      );

      await expect(
        service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
      ).rejects.toThrow(message);
      expect(
        cleanupPorts.deleteBoundStorageForTrustedSelfTest,
      ).not.toHaveBeenCalled();
    },
  );

  it('rejects cleanup when the closing record fingerprint differs from the completed ledger', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir: '',
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const executionPorts = createPorts();
    await service.enqueue(request(), executionPorts);
    await waitForCompleted(service, executionPorts);
    const cleanupPorts = createCleanupPorts();
    cleanupPorts.readReportStrict.mockResolvedValueOnce({
      ...persistedSnapshot(),
      fingerprint: 'f'.repeat(64),
    });
    const cleanupRequest = selfTestCleanupRequest();
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await expect(
      service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
    ).rejects.toThrow('指纹');
    expect(
      cleanupPorts.findBoundStorageForTrustedSelfTest,
    ).not.toHaveBeenCalled();
    expect(
      cleanupPorts.deleteBoundStorageForTrustedSelfTest,
    ).not.toHaveBeenCalled();
  });

  it('rejects cleanup for an object outside the completed ledger source and upload sets', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir: '',
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const executionPorts = createPorts();
    await service.enqueue(request(), executionPorts);
    await waitForCompleted(service, executionPorts);
    const cleanupPorts = createCleanupPorts();
    cleanupPorts.findBoundStorageForTrustedSelfTest.mockResolvedValueOnce({
      id: 'storage-summary-2',
      boundRecordId: 'recSummaryReport123456',
      fileToken: 'file-token-summary-1',
      ownerMutationId: MUTATION_ID,
    });
    const cleanupRequest = selfTestCleanupRequest({
      objectId: 'storage-summary-2',
    });
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await expect(
      service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
    ).rejects.toThrow('本地任务');
    expect(
      cleanupPorts.deleteBoundStorageForTrustedSelfTest,
    ).not.toHaveBeenCalled();
  });

  it('rejects cleanup when the bound file token differs from that object ledger upload', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir: '',
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const executionPorts = createPorts();
    await service.enqueue(request(), executionPorts);
    await waitForCompleted(service, executionPorts);
    const cleanupPorts = createCleanupPorts();
    cleanupPorts.readReportStrict.mockResolvedValueOnce({
      ...persistedSnapshot(),
      reportFileTokens: ['file-token-from-other-upload'],
    });
    cleanupPorts.findBoundStorageForTrustedSelfTest.mockResolvedValueOnce({
      id: 'storage-summary-1',
      boundRecordId: 'recSummaryReport123456',
      fileToken: 'file-token-from-other-upload',
      ownerMutationId: MUTATION_ID,
    });
    const cleanupRequest = selfTestCleanupRequest();
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await expect(
      service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
    ).rejects.toThrow('附件令牌');
    expect(
      cleanupPorts.deleteBoundStorageForTrustedSelfTest,
    ).not.toHaveBeenCalled();
  });

  it('rejects an expired cleanup proof before reading Base or storage', async () => {
    const service = new ChangeSummaryReportService({
      ledgerDir: '',
      cleanupSecret: CLEANUP_SECRET,
      now: () => new Date(CLEANUP_NOW),
    });
    const cleanupPorts = createCleanupPorts();
    const cleanupRequest = selfTestCleanupRequest({
      expiresAt: CLEANUP_NOW - 1,
    });
    const proof = createChangeSummaryReportCleanupProof(
      cleanupRequest,
      CLEANUP_SECRET,
    );

    await expect(
      service.cleanupBoundAttachment(cleanupRequest, proof, cleanupPorts),
    ).rejects.toThrow('已失效');
    expect(cleanupPorts.readReportStrict).not.toHaveBeenCalled();
    expect(
      cleanupPorts.findBoundStorageForTrustedSelfTest,
    ).not.toHaveBeenCalled();
  });
});

function targetSnapshot() {
  return {
    recordId: 'recChange12345678',
    title: SELF_TEST_MARKER,
    submitterName: '彭怀响',
    progress: '已结束',
    level: '中',
    workflowStatus: '通过',
    hasSummaryReport: false,
    plannedStartAt: '2026-06-01T00:00:00+08:00',
    plannedEndAt: '2026-06-01T18:00:00+08:00',
  };
}

function persistedSnapshot() {
  return {
    recordId: 'recSummaryReport123456',
    clientMutationId: MUTATION_ID,
    fingerprint: buildChangeSummaryReportFingerprint(request()),
    changeRecordId: 'recChange12345678',
    reportFileTokens: ['file-token-summary-1'],
  };
}

function createPorts() {
  let createdInput: {
    clientMutationId: string;
    fingerprint: string;
    changeRecordId: string;
    reportFileTokens: string[];
  } | null = null;
  const ports = {
    readChangeStrict: jest.fn().mockResolvedValue(targetSnapshot()),
    findReportByMutationId: jest.fn().mockResolvedValue(null),
    findReportByChangeRecordId: jest.fn().mockResolvedValue(null),
    resolveOwnedStorage: jest.fn().mockResolvedValue(storedFile()),
    uploadToBitable: jest.fn().mockResolvedValue('file-token-summary-1'),
    createReport: jest.fn().mockImplementation(async (input) => {
      createdInput = input;
      return 'recSummaryReport123456';
    }),
    readReportStrict: jest.fn().mockImplementation(async () =>
      createdInput
        ? {
            recordId: 'recSummaryReport123456',
            clientMutationId: createdInput.clientMutationId,
            fingerprint: createdInput.fingerprint,
            changeRecordId: createdInput.changeRecordId,
            reportFileTokens: [...createdInput.reportFileTokens],
          }
        : persistedSnapshot(),
    ),
    bindStorageToRecord: jest.fn().mockResolvedValue(undefined),
    invalidateChangeCaches: jest.fn(),
  } satisfies jest.Mocked<ChangeSummaryReportExecutionPorts>;
  return ports;
}

function selfTestCleanupRequest(
  patch: Partial<ChangeSummaryReportSelfTestCleanupRequest> = {},
): ChangeSummaryReportSelfTestCleanupRequest {
  return {
    summaryReportRecordId: 'recSummaryReport123456',
    changeRecordId: 'recChange12345678',
    changeRequestMutationId: CHANGE_REQUEST_MUTATION_ID,
    clientMutationId: MUTATION_ID,
    objectId: 'storage-summary-1',
    summaryMarker: SELF_TEST_MARKER,
    submitterName: '彭怀响',
    fileToken: 'file-token-summary-1',
    expiresAt: CLEANUP_NOW + 60_000,
    ...patch,
  };
}

function createCleanupPorts() {
  return {
    readChangeStrict: jest.fn().mockResolvedValue(targetSnapshot()),
    readReportStrict: jest.fn().mockResolvedValue(persistedSnapshot()),
    findBoundStorageForTrustedSelfTest: jest.fn().mockResolvedValue({
      id: 'storage-summary-1',
      boundRecordId: 'recSummaryReport123456',
      fileToken: 'file-token-summary-1',
      ownerMutationId: MUTATION_ID,
    }),
    deleteBoundStorageForTrustedSelfTest: jest.fn().mockResolvedValue(true),
    scrubChangeRequestSelfTestLedger: jest.fn().mockResolvedValue(undefined),
  } satisfies jest.Mocked<ChangeSummaryReportCleanupPorts>;
}

function abandonRequest(): ChangeSummaryReportAbandonRequest {
  return {
    clientMutationId: MUTATION_ID,
    changeRecordId: 'recChange12345678',
    submitterName: '彭怀响',
  };
}

function createAbandonPorts() {
  let reportExists = true;
  return {
    readReportStrict: jest
      .fn()
      .mockImplementation(async () =>
        reportExists ? persistedSnapshot() : null,
      ),
    findReportByMutationId: jest
      .fn()
      .mockImplementation(async () =>
        reportExists ? persistedSnapshot() : null,
      ),
    findBoundStorage: jest.fn().mockResolvedValue({
      id: 'storage-summary-1',
      boundRecordId: 'recSummaryReport123456',
      fileToken: 'file-token-summary-1',
      ownerMutationId: MUTATION_ID,
    }),
    deleteOwnedStorage: jest.fn().mockResolvedValue(true),
    deleteBoundStorage: jest.fn().mockResolvedValue(true),
    deleteReportStrict: jest.fn().mockImplementation(async () => {
      reportExists = false;
    }),
    invalidateChangeCaches: jest.fn().mockResolvedValue(undefined),
  } satisfies jest.Mocked<ChangeSummaryReportAbandonPorts>;
}

async function writeChangeRequestSelfTestLedger(directory: string) {
  const fingerprint = 'a'.repeat(64);
  const prefix = join(directory, CHANGE_REQUEST_MUTATION_ID);
  await writeFile(`${prefix}.sha256`, `${fingerprint}\n`);
  await writeFile(
    `${prefix}.upload.0.json`,
    JSON.stringify({
      version: 1,
      state: 'uploaded',
      clientMutationId: CHANGE_REQUEST_MUTATION_ID,
      fingerprint,
      index: 0,
      document: {
        fileToken: 'file-token-change-1',
        storageId: 'storage-change-1',
        name: 'self-test.pdf',
        size: 128,
      },
    }),
  );
  await writeFile(
    `${prefix}.record.json`,
    JSON.stringify({
      version: 1,
      state: 'record-created',
      clientMutationId: CHANGE_REQUEST_MUTATION_ID,
      fingerprint,
      recordId: 'recChange12345678',
    }),
  );
  await writeFile(
    `${prefix}.completed.json`,
    JSON.stringify({
      version: 1,
      state: 'completed',
      clientMutationId: CHANGE_REQUEST_MUTATION_ID,
      fingerprint,
      recordId: 'recChange12345678',
      response: {
        success: true,
        clientMutationId: CHANGE_REQUEST_MUTATION_ID,
        message: 'ok',
        record: {
          id: 'recChange12345678',
          bitableRecordId: 'recChange12345678',
          title: SELF_TEST_MARKER,
          submitterName: '彭怀响',
        },
      },
    }),
  );
}

async function waitForStatus(
  service: ChangeSummaryReportService,
  ports: jest.Mocked<ChangeSummaryReportExecutionPorts>,
  status: 'failed' | 'completed',
  mutationId = MUTATION_ID,
) {
  const deadline = Date.now() + 10_000;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const current = await service.getStatus(mutationId, ports);
    lastStatus = `${current.status}/${current.phase}`;
    if (current.status === status) {
      await service.waitForIdle();
      return service.getStatus(mutationId, ports);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `task did not reach ${status} before deadline; last=${lastStatus}`,
  );
}

async function waitForCompleted(
  service: ChangeSummaryReportService,
  ports: jest.Mocked<ChangeSummaryReportExecutionPorts>,
  mutationId = MUTATION_ID,
) {
  return waitForStatus(service, ports, 'completed', mutationId);
}
