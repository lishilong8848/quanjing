jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'app',
      app_secret: 'secret',
    })),
    parseFeishuBitableLink: jest.fn(() => ({
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
    readEnv: jest.fn((name: string, aliases: string[] = []) => {
      for (const key of [name, ...aliases]) {
        const value = process.env[key]?.trim();
        if (value) return value;
      }
      return '';
    }),
  }),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn().mockResolvedValue('app-token'),
  fetchBitableRecords: jest.fn().mockResolvedValue([]),
  invalidateBitableRecordCache: jest.fn(),
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PurchaseApplicationBatchRequest } from '../../shared/purchase-application.interface';
import {
  PurchaseApplicationTaskLedgerStore,
  type PurchaseApplicationTaskLedgerEntry,
} from '../../server/modules/purchase-inventory/purchase-application-task-ledger.store';
import {
  buildPurchaseApplicationSubmissionFingerprint,
  normalizePurchaseApplicationUploadFileName,
  PurchaseApplicationService,
  type PurchaseApplicationUploadFile,
} from '../../server/modules/purchase-inventory/purchase-application.service';

describe('PurchaseApplicationService durable idempotency', () => {
  const principalFingerprint = 'principal-fingerprint-A';
  const otherPrincipalFingerprint = 'principal-fingerprint-B';
  const temporaryDirectories: string[] = [];
  const originalSubmissionTable =
    process.env.FEISHU_PURCHASE_SUBMISSION_TABLE_ID;
  const originalExecutionTable = process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID;

  beforeEach(() => {
    process.env.FEISHU_PURCHASE_SUBMISSION_TABLE_ID = 'tblSubmission123';
    process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID = 'tblExecution123';
  });

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    restoreEnv('FEISHU_PURCHASE_SUBMISSION_TABLE_ID', originalSubmissionTable);
    restoreEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID', originalExecutionTable);
  });

  it('keeps the documented browser/server fingerprint vector stable', () => {
    const request = {
      shared: { building: 'H楼', applicantOpenId: 'ou_test' },
      items: [{ lineId: 'line-1', quantity: 2 }],
    } as unknown as PurchaseApplicationBatchRequest;

    expect(
      buildPurchaseApplicationSubmissionFingerprint(request, [
        uploadFile('quote.pdf', Buffer.from('attachment-bytes')),
      ]),
    ).toBe('2da834eb56a66be67f61825cdc23911295aa4d92f66cb39cbae51ace630c6242');
  });

  it('repairs Multer Latin1 mojibake before hashing a Chinese attachment name', () => {
    const request = {
      shared: { building: 'H楼', applicantOpenId: 'ou_test' },
      items: [{ lineId: 'line-1', quantity: 2 }],
    } as unknown as PurchaseApplicationBatchRequest;
    const browserName = '三方比价单.pdf';
    const browserFile = uploadFile(browserName, Buffer.from('中文附件内容'));
    const multerFile = {
      ...browserFile,
      originalname: Buffer.from(browserName, 'utf8').toString('latin1'),
    };

    expect(
      buildPurchaseApplicationSubmissionFingerprint(request, [multerFile]),
    ).toBe('6f829a3d917f10d684c4fc75d9188b3fb82b3609ec90f6d3f8b3d39f140c9a0d');
    expect(
      buildPurchaseApplicationSubmissionFingerprint(request, [multerFile]),
    ).toBe(
      buildPurchaseApplicationSubmissionFingerprint(request, [browserFile]),
    );
  });

  it('repairs a valid long Chinese Multer filename before applying the character limit', () => {
    const browserName = `${'中'.repeat(61)}.pdf`;
    const multerName = Buffer.from(browserName, 'utf8').toString('latin1');

    expect(multerName.length).toBeGreaterThan(180);
    expect(normalizePurchaseApplicationUploadFileName(multerName)).toBe(
      browserName,
    );
  });

  it.each(['', 'bad\u0000name.pdf', 'broken-\ufffd.pdf', 'nested/path.pdf'])(
    'fails closed for an unsafe or irreversibly decoded attachment name',
    (name) => {
      const request = {
        shared: { building: 'H楼', applicantOpenId: 'ou_test' },
        items: [{ lineId: 'line-1', quantity: 2 }],
      } as unknown as PurchaseApplicationBatchRequest;

      expect(() =>
        buildPurchaseApplicationSubmissionFingerprint(request, [
          uploadFile(name, Buffer.from('attachment')),
        ]),
      ).toThrow(BadRequestException);
    },
  );

  it('preserves an already decoded Latin-1 Unicode attachment name', () => {
    expect(normalizePurchaseApplicationUploadFileName('café résumé.pdf')).toBe(
      'café résumé.pdf',
    );
    expect(
      normalizePurchaseApplicationUploadFileName(' report 2026.pdf '),
    ).toBe(' report 2026.pdf ');
  });

  it.each([
    ['', 'a'.repeat(64)],
    ['short', 'a'.repeat(64)],
    ['purchase-mutation-valid', ''],
    ['purchase-mutation-valid', 'not-a-sha256'],
  ])('rejects a missing or malformed idempotency proof', (key, fingerprint) => {
    const { service } = createService();

    expect(() =>
      service.acceptApplications(
        validRequest(),
        [],
        '2026-07-10',
        key,
        fingerprint,
      ),
    ).toThrow(BadRequestException);
  });

  it('fails closed when a valid submission is missing the guard principal fingerprint', () => {
    const { service } = createService();
    const request = validRequest();

    expect(() =>
      service.acceptApplications(
        request,
        [],
        '2026-07-10',
        'purchase-missing-principal',
        buildPurchaseApplicationSubmissionFingerprint(request, []),
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      service.getSubmissionTaskStatus('purchase-application-unknown'),
    ).toThrow(ForbiddenException);
  });

  it('includes attachment metadata and SHA-256 in the verified fingerprint', async () => {
    const { service } = createService();
    const submit = jest
      .spyOn(service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const request = offlineRequest();
    const firstFile = uploadFile('comparison.pdf', Buffer.from('first'));
    const changedFile = uploadFile('comparison.pdf', Buffer.from('changed'));
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(request, [
      firstFile,
    ]);

    const accepted = service.acceptApplications(
      request,
      [firstFile],
      '2026-07-10',
      'purchase-mutation-attachment',
      fingerprint,
      request,
      principalFingerprint,
    );
    expect(
      service.acceptApplications(
        structuredClone(request),
        [],
        '2026-07-10',
        'purchase-mutation-attachment',
        fingerprint,
        request,
        principalFingerprint,
      ).taskId,
    ).toBe(accepted.taskId);
    expect(() =>
      service.acceptApplications(
        structuredClone(request),
        [changedFile],
        '2026-07-10',
        'purchase-mutation-attachment',
        buildPurchaseApplicationSubmissionFingerprint(request, [changedFile]),
        request,
        principalFingerprint,
      ),
    ).toThrow(ConflictException);
    expect(() =>
      service.acceptApplications(
        structuredClone(request),
        [changedFile],
        '2026-07-10',
        'purchase-mutation-attachment',
        fingerprint,
        request,
        principalFingerprint,
      ),
    ).toThrow(BadRequestException);

    await waitForTerminal(service, accepted.taskId);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('returns the original terminal task after process restart without executing again', async () => {
    const ledgerPath = temporaryLedgerPath();
    const first = createService(ledgerPath);
    const firstSubmit = jest
      .spyOn(first.service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const request = validRequest();
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );
    const accepted = first.service.acceptApplications(
      request,
      [],
      '2026-07-10',
      'purchase-mutation-restart',
      fingerprint,
      request,
      principalFingerprint,
    );
    await waitForTerminal(first.service, accepted.taskId);

    const restarted = createService(ledgerPath);
    const restartedSubmit = jest
      .spyOn(restarted.service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const duplicate = restarted.service.acceptApplications(
      structuredClone(request),
      [],
      '2026-07-10',
      'purchase-mutation-restart',
      fingerprint,
      request,
      principalFingerprint,
    );

    expect(duplicate.taskId).toBe(accepted.taskId);
    expect(
      restarted.service.getSubmissionTaskStatus(
        accepted.taskId,
        undefined,
        principalFingerprint,
      ),
    ).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(firstSubmit).toHaveBeenCalledTimes(1);
    expect(restartedSubmit).not.toHaveBeenCalled();
  });

  it('refreshes a cached in-flight task from the durable ledger when another service completes it', async () => {
    const ledgerPath = temporaryLedgerPath();
    const first = createService(ledgerPath);
    let releaseSubmission!: () => void;
    const submissionGate = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    jest
      .spyOn(first.service, 'submitApplications')
      .mockImplementation(async () => {
        await submissionGate;
        return successfulResult();
      });
    const request = validRequest();
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );
    const accepted = first.service.acceptApplications(
      request,
      [],
      '2026-07-10',
      'purchase-cross-service-status',
      fingerprint,
      request,
      principalFingerprint,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const second = createService(ledgerPath);
    expect(
      second.service.getSubmissionTaskStatus(
        accepted.taskId,
        'H楼',
        principalFingerprint,
      ),
    ).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          status: expect.stringMatching(/^(pending|running)$/),
        }),
      }),
    );

    releaseSubmission();
    await waitForTerminal(first.service, accepted.taskId);

    expect(
      second.service.getSubmissionTaskStatus(
        accepted.taskId,
        'H楼',
        principalFingerprint,
      ),
    ).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  it('isolates the same building and idempotency key by authenticated principal', async () => {
    const { service } = createService();
    const submit = jest
      .spyOn(service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const request = validRequest();
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );

    const first = service.acceptApplications(
      request,
      [],
      '2026-07-10',
      'purchase-principal-isolation',
      fingerprint,
      request,
      principalFingerprint,
    );
    expect(
      service.findAcceptedApplication(
        structuredClone(request),
        [],
        'H楼',
        'purchase-principal-isolation',
        fingerprint,
        otherPrincipalFingerprint,
      ),
    ).toBeNull();
    const second = service.acceptApplications(
      structuredClone(request),
      [],
      '2026-07-10',
      'purchase-principal-isolation',
      fingerprint,
      request,
      otherPrincipalFingerprint,
    );

    expect(second.taskId).not.toBe(first.taskId);
    expect(
      service.getSubmissionTaskStatus(
        first.taskId,
        'H楼',
        otherPrincipalFingerprint,
      ),
    ).toEqual(expect.objectContaining({ success: false }));
    expect(
      service.getSubmissionTaskStatus(
        first.taskId,
        'H楼',
        principalFingerprint,
      ),
    ).toEqual(expect.objectContaining({ success: true }));

    await waitForTerminal(service, first.taskId, principalFingerprint);
    await waitForTerminal(service, second.taskId, otherPrincipalFingerprint);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('finds an existing durable task locally without refreshing external applicant data', async () => {
    const ledgerPath = temporaryLedgerPath();
    const first = createService(ledgerPath);
    jest
      .spyOn(first.service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const request = validRequest();
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );
    const accepted = first.service.acceptApplications(
      request,
      [],
      '2026-07-10',
      'purchase-fast-local-reuse',
      fingerprint,
      request,
      principalFingerprint,
    );
    await waitForTerminal(first.service, accepted.taskId, principalFingerprint);

    const restarted = createService(ledgerPath);
    expect(
      restarted.service.findAcceptedApplication(
        structuredClone(request),
        [],
        'H楼',
        'purchase-fast-local-reuse',
        fingerprint,
        principalFingerprint,
      ),
    ).toEqual(expect.objectContaining({ taskId: accepted.taskId }));
  });

  it('revalidates applicant identity in the background before the first business write', async () => {
    const { service } = createService();
    const request = validRequest();
    request.shared.applicantName = '客户端旧姓名';
    request.shared.applicantEmployeeNo = 'CLIENT-OLD';
    request.shared.applicantPosition = '客户端旧岗位';
    const resolveApplicant = jest
      .spyOn(service, 'resolveApplicantForBuilding')
      .mockResolvedValue({
        recordId: 'rec-ma',
        openId: 'ou_ma',
        name: '权威姓名',
        employeeNo: 'NT-AUTH-001',
        position: '权威岗位',
        building: 'H楼',
        specialty: '综合',
      });
    const submit = jest
      .spyOn(service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );

    const accepted = (
      service.acceptApplications as unknown as (
        ...args: [
          ...Parameters<PurchaseApplicationService['acceptApplications']>,
          boolean,
        ]
      ) => ReturnType<PurchaseApplicationService['acceptApplications']>
    )(
      request,
      [],
      '2026-07-10',
      'purchase-background-applicant',
      fingerprint,
      request,
      principalFingerprint,
      true,
    );
    await waitForTerminal(service, accepted.taskId);

    expect(resolveApplicant).toHaveBeenCalledWith(
      { recordId: 'rec-ma', openId: 'ou_ma', building: 'H楼' },
      true,
    );
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        shared: expect.objectContaining({
          applicantRecordId: 'rec-ma',
          applicantOpenId: 'ou_ma',
          applicantName: '权威姓名',
          applicantEmployeeNo: 'NT-AUTH-001',
          applicantPosition: '权威岗位',
          applicantBuilding: 'H楼',
        }),
      }),
      [],
      '2026-07-10',
    );
  });

  it('marks a rejected background applicant as definitely not written', async () => {
    const { service } = createService();
    const request = validRequest();
    jest.spyOn(service, 'resolveApplicantForBuilding').mockResolvedValue(null);
    const submit = jest
      .spyOn(service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );

    const accepted = (
      service.acceptApplications as unknown as (
        ...args: [
          ...Parameters<PurchaseApplicationService['acceptApplications']>,
          boolean,
        ]
      ) => ReturnType<PurchaseApplicationService['acceptApplications']>
    )(
      request,
      [],
      '2026-07-10',
      'purchase-rejected-applicant',
      fingerprint,
      request,
      principalFingerprint,
      true,
    );
    const terminal = await waitForTerminal(service, accepted.taskId);

    expect(terminal).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          status: 'failed',
          definitelyNotWritten: true,
          message: expect.stringContaining('申请人'),
        }),
      }),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('rebuilds a persisted in-flight task as uncertain after its owner is gone', () => {
    const ledgerPath = temporaryLedgerPath();
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    store.reserve(pendingLedgerEntry());
    const persisted = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      entries: Array<{ owner?: { pid: number; processStartedAtMs: number } }>;
    };
    persisted.entries[0].owner = {
      ...persisted.entries[0].owner!,
      pid: 2_147_483_647,
      processStartedAtMs: 0,
    };
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      'utf8',
    );
    const { service } = createService(ledgerPath);
    const submit = jest.spyOn(service, 'submitApplications');

    expect(
      service.getSubmissionTaskStatus(
        'purchase-application-persisted-pending',
        'H楼',
        principalFingerprint,
      ),
    ).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          status: 'uncertain',
          message: expect.stringContaining('结果暂不确定'),
        }),
      }),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('recovers the original task after the in-memory 100-task window is pruned', async () => {
    const { service } = createService();
    const submit = jest
      .spyOn(service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const request = validRequest();
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );
    const accepted = Array.from({ length: 101 }, (_, index) =>
      service.acceptApplications(
        request,
        [],
        '2026-07-10',
        `purchase-memory-${String(index).padStart(3, '0')}`,
        fingerprint,
        request,
        principalFingerprint,
      ),
    );
    await waitForTerminal(
      service,
      accepted.at(-1)!.taskId,
      principalFingerprint,
      300,
    );

    const recovered = service.acceptApplications(
      structuredClone(request),
      [],
      '2026-07-10',
      'purchase-memory-000',
      fingerprint,
      request,
      principalFingerprint,
    );

    expect(recovered.taskId).toBe(accepted[0].taskId);
    expect(submit).toHaveBeenCalledTimes(101);
  }, 60_000);

  it('serializes concurrent reservations for one building and key', async () => {
    const { service } = createService();
    const submit = jest
      .spyOn(service, 'submitApplications')
      .mockResolvedValue(successfulResult());
    const request = validRequest();
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );

    const accepted = await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve().then(() =>
          service.acceptApplications(
            structuredClone(request),
            [],
            '2026-07-10',
            'purchase-mutation-concurrent',
            fingerprint,
            request,
            principalFingerprint,
          ),
        ),
      ),
    );

    expect(new Set(accepted.map((item) => item.taskId)).size).toBe(1);
    await waitForTerminal(service, accepted[0].taskId);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the durable ledger is corrupted', () => {
    const ledgerPath = temporaryLedgerPath();
    writeFileSync(ledgerPath, '{broken', 'utf8');
    const { service } = createService(ledgerPath);
    const request = validRequest();

    expect(() =>
      service.acceptApplications(
        request,
        [],
        '2026-07-10',
        'purchase-mutation-corrupt',
        buildPurchaseApplicationSubmissionFingerprint(request, []),
        request,
        principalFingerprint,
      ),
    ).toThrow(ServiceUnavailableException);
  });

  it.each([
    ['running', 0],
    ['completed', 1],
  ] as const)(
    'returns a secured in-memory uncertain terminal when persisting %s fails permanently',
    async (failingStatus, expectedSubmitCalls) => {
      const ledgerPath = temporaryLedgerPath();
      const { store, service } = createService(ledgerPath);
      const submit = jest
        .spyOn(service, 'submitApplications')
        .mockResolvedValue(successfulResult());
      const updateTask = store.updateTask.bind(store);
      const findByTaskId = store.findByTaskId.bind(store);
      let ledgerUnavailable = false;
      jest.spyOn(store, 'updateTask').mockImplementation((taskId, task) => {
        if (task.status === failingStatus) {
          ledgerUnavailable = true;
          throw new ServiceUnavailableException('simulated disk failure');
        }
        return updateTask(taskId, task);
      });
      jest.spyOn(store, 'findByTaskId').mockImplementation((taskId) => {
        if (ledgerUnavailable) {
          throw new ServiceUnavailableException('simulated disk failure');
        }
        return findByTaskId(taskId);
      });
      const request = validRequest();
      const accepted = service.acceptApplications(
        request,
        [],
        '2026-07-10',
        `purchase-ledger-${failingStatus}`,
        buildPurchaseApplicationSubmissionFingerprint(request, []),
        request,
        principalFingerprint,
      );
      for (let attempt = 0; attempt < 20 && !ledgerUnavailable; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(ledgerUnavailable).toBe(true);

      expect(
        service.getSubmissionTaskStatus(
          accepted.taskId,
          'H楼',
          principalFingerprint,
        ),
      ).toEqual(
        expect.objectContaining({
          success: true,
          task: expect.objectContaining({
            status: 'uncertain',
            message: expect.stringContaining('结果暂不确定'),
          }),
        }),
      );
      expect(
        service.getSubmissionTaskStatus(
          accepted.taskId,
          'H楼',
          otherPrincipalFingerprint,
        ),
      ).toEqual(expect.objectContaining({ success: false }));
      expect(submit).toHaveBeenCalledTimes(expectedSubmitCalls);
    },
  );

  function createService(ledgerPath = temporaryLedgerPath()) {
    const store = new PurchaseApplicationTaskLedgerStore(ledgerPath);
    return {
      store,
      service: new PurchaseApplicationService(
        { axiosRef: {} } as never,
        undefined,
        undefined,
        store,
      ),
    };
  }

  function temporaryLedgerPath(): string {
    const directory = mkdtempSync(
      join(tmpdir(), 'purchase-application-service-ledger-'),
    );
    temporaryDirectories.push(directory);
    return join(directory, 'purchase-application-ledger.json');
  }
});

function pendingLedgerEntry(): PurchaseApplicationTaskLedgerEntry {
  return {
    building: 'H楼',
    principalFingerprint: 'principal-fingerprint-A',
    idempotencyKey: 'purchase-mutation-pending',
    requestFingerprint: '1'.repeat(64),
    submissionFingerprint: '2'.repeat(64),
    task: {
      id: 'purchase-application-persisted-pending',
      status: 'pending',
      message: '后台同步中',
      createdAt: '2026-08-11T00:00:00.000Z',
    },
  };
}

function validRequest(): PurchaseApplicationBatchRequest {
  return {
    shared: {
      applicantRecordId: 'rec-ma',
      applicantOpenId: 'ou_ma',
      applicantName: '马金玉',
      applicantEmployeeNo: 'NT-001',
      applicantPosition: '综合管理',
      applicantBuilding: 'H楼',
      building: 'H楼',
      specialty: '其他',
      purchaseMethod: '综合采购',
      purchaseChannel: '线上',
      supplier: '南通供应商',
      onlineUrl: 'https://purchase.example.com/item',
      procurementForm: '三方比价',
      comparisonSatisfied: '是',
      singleReason: '',
      requirementSummary: '办公物资补充',
      expectedDeliveryDate: '2026-07-20',
      immediateOutbound: false,
      notes: '批量申请',
    },
    items: [
      {
        lineId: 'line-1',
        mode: 'existing',
        catalogRecordId: 'catalog-1',
        sku: 'D2-001',
        primaryCategory: 'D消耗类',
        secondaryCategory: '办公耗材D2',
        itemName: 'A4纸',
        specification: '80g 500张',
        brand: '得力',
        quantity: 2,
        unit: '包',
        unitPrice: 25.5,
        shippingFee: 5,
        discount: 1,
      },
    ],
  };
}

function offlineRequest(): PurchaseApplicationBatchRequest {
  const request = validRequest();
  request.shared.purchaseChannel = '线下';
  request.shared.onlineUrl = '';
  request.items = request.items.map((item) => ({
    ...item,
    onlineUrls: [],
  }));
  return request;
}

function uploadFile(
  originalname: string,
  buffer: Buffer,
): PurchaseApplicationUploadFile {
  return {
    originalname,
    mimetype: 'application/pdf',
    size: buffer.byteLength,
    buffer,
  };
}

function successfulResult() {
  return {
    success: true,
    created: [],
    failed: [],
    warnings: [],
    message: '已完成',
  };
}

async function waitForTerminal(
  service: PurchaseApplicationService,
  taskId: string,
  principalFingerprint = 'principal-fingerprint-A',
  maxAttempts = 80,
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = service.getSubmissionTaskStatus(
      taskId,
      undefined,
      principalFingerprint,
    );
    if (
      status.task?.status === 'completed' ||
      status.task?.status === 'failed'
    ) {
      return status;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Task ${taskId} did not finish`);
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
