import type { ChangeInfo } from '../../shared/api.interface';
import type { ChangeSummaryReportCreateRequest } from '../../shared/change-summary-report';
import {
  clearChangeSummaryReportRecovery,
  consumeChangeSummaryReportRecoveryAuthorization,
  createChangeSummaryReportRecoveryOriginal,
  CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BINDINGS,
  getPendingChangeSummaryReportRecordIds,
  persistChangeSummaryReportRecovery,
  readChangeSummaryReportRecovery,
  readChangeSummaryReportRecoveries,
  removeChangeSummaryReportRecovery,
  upsertChangeSummaryReportRecoveryBinding,
  type ChangeSummaryReportRecoveryBinding,
  type ChangeSummaryReportRecoveryStorage,
} from '../../client/src/pages/MonthlySchedule/change-summary-report-recovery';

const principalA = 'principal-a-1234567890';
const principalB = 'principal-b-1234567890';

const request: ChangeSummaryReportCreateRequest = {
  clientMutationId:
    'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
  submitterName: '马进宇',
  changeRecordId: 'recChange12345678',
  summaryDocuments: [
    {
      name: '变更总结.pdf',
      type: 'application/pdf',
      size: 1024,
      objectStorage: {
        id: 'storage-summary-1',
        filePath: 'change-summary/report.pdf',
        bucketId: 'default-bucket',
        url: 'https://storage.example.test/change-summary/report.pdf',
      },
    },
  ],
};

const original: ChangeInfo = {
  id: 'recChange12345678',
  bitableRecordId: 'recChange12345678',
  title: '已结束变更',
  startDate: '2026-08-11T09:00:00+08:00',
  endDate: '2026-08-11T18:00:00+08:00',
  actualStartDate: '2026-08-11T09:00:00+08:00',
  actualEndDate: '2026-08-11T18:00:00+08:00',
  plannedDelayStartDate: null,
  plannedDelayEndDate: null,
  level: '低',
  type: '计划性变更',
  progress: '已结束',
  executor: null,
  submitterName: '马进宇',
  workflowStatus: '审批通过',
  hasSummaryReport: false,
  buildings: ['A楼'],
  riskSummary: '风险点',
  isKey: false,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-11T10:00:00.000Z',
};

const recoveryOriginal = createChangeSummaryReportRecoveryOriginal(original);

describe('change summary report recovery', () => {
  let storage: ChangeSummaryReportRecoveryStorage;
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
  });

  it('persists only the minimal staged draft and pending task for one principal', () => {
    const binding: ChangeSummaryReportRecoveryBinding = {
      request,
      original: {
        ...recoveryOriginal,
        planDocuments: [
          {
            fileToken: 'sensitive-token',
            name: 'old-plan.pdf',
            url: 'https://sensitive.example.test/old-plan.pdf',
          },
        ],
        recordUrl: 'https://sensitive.example.test/change-record',
      } as ChangeSummaryReportRecoveryBinding['original'],
      state: 'pending',
      taskId: 'summary-task-1',
    };

    expect(
      persistChangeSummaryReportRecovery(binding, principalA, storage),
    ).toBe(true);
    const restored = readChangeSummaryReportRecovery(principalA, storage);
    expect(restored).toEqual({
      ...binding,
      original: recoveryOriginal,
    });
    expect(JSON.stringify(restored)).not.toContain('sensitive-token');
    expect(JSON.stringify(restored)).not.toContain('sensitive.example.test');
  });

  it('keeps independent tasks and derives pending records without treating failures as pending', () => {
    const secondRequest = {
      ...request,
      clientMutationId:
        'change-summary-report-223e4567-e89b-42d3-a456-426614174000',
      changeRecordId: 'recSecond12345678',
    };
    const secondOriginal = {
      ...original,
      id: 'recSecond12345678',
      bitableRecordId: 'recSecond12345678',
    };
    const pending: ChangeSummaryReportRecoveryBinding = {
      request,
      original: recoveryOriginal,
      state: 'pending',
      taskId: 'summary-task-1',
    };
    const failed: ChangeSummaryReportRecoveryBinding = {
      request: secondRequest,
      original: createChangeSummaryReportRecoveryOriginal(secondOriginal),
      state: 'failed',
      taskId: 'summary-task-2',
      error: '同步失败',
    };

    persistChangeSummaryReportRecovery(pending, principalA, storage);
    persistChangeSummaryReportRecovery(failed, principalA, storage);

    expect(readChangeSummaryReportRecoveries(principalA, storage)).toEqual([
      pending,
      failed,
    ]);
    expect([
      ...getPendingChangeSummaryReportRecordIds([pending, failed]),
    ]).toEqual(['recChange12345678']);
    expect(upsertChangeSummaryReportRecoveryBinding([pending], failed)).toEqual(
      [pending, failed],
    );
    expect(
      removeChangeSummaryReportRecovery(
        request.clientMutationId,
        principalA,
        storage,
      ),
    ).toBe(true);
    expect(readChangeSummaryReportRecoveries(principalA, storage)).toEqual([
      failed,
    ]);
  });

  it('isolates A -> guest -> B recovery authorization by principal fingerprint', () => {
    const read = jest.fn((principalFingerprint: string) => [
      {
        request: {
          ...request,
          submitterName: principalFingerprint === principalA ? '马进宇' : '乙',
        },
        original: recoveryOriginal,
        state: 'pending' as const,
      },
    ]);

    const authorizedA = consumeChangeSummaryReportRecoveryAuthorization(
      true,
      principalA,
      null,
      read,
    );
    expect(authorizedA.consumedPrincipalFingerprint).toBe(principalA);
    expect(authorizedA.bindings).toHaveLength(1);

    const guest = consumeChangeSummaryReportRecoveryAuthorization(
      false,
      '',
      authorizedA.consumedPrincipalFingerprint,
      read,
    );
    expect(guest).toEqual({
      consumedPrincipalFingerprint: null,
      bindings: [],
    });

    const authorizedB = consumeChangeSummaryReportRecoveryAuthorization(
      true,
      principalB,
      guest.consumedPrincipalFingerprint,
      read,
    );
    expect(authorizedB.consumedPrincipalFingerprint).toBe(principalB);
    expect(authorizedB.bindings[0]?.request.submitterName).toBe('乙');
    expect(read).toHaveBeenNthCalledWith(1, principalA);
    expect(read).toHaveBeenNthCalledWith(2, principalB);

    const repeated = consumeChangeSummaryReportRecoveryAuthorization(
      true,
      principalB,
      authorizedB.consumedPrincipalFingerprint,
      read,
    );
    expect(repeated).toEqual({
      consumedPrincipalFingerprint: principalB,
      bindings: [],
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never reads storage without an authorized principal', () => {
    const read = jest.fn(() => []);
    const guest = consumeChangeSummaryReportRecoveryAuthorization(
      false,
      '',
      null,
      read,
    );
    expect(guest.bindings).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('persists a failed task with an actionable error for exact draft recovery', () => {
    const binding: ChangeSummaryReportRecoveryBinding = {
      request,
      original: recoveryOriginal,
      state: 'failed',
      taskId: 'summary-task-1',
      error: '附件同步失败，请重试',
    };

    persistChangeSummaryReportRecovery(binding, principalA, storage);

    expect(readChangeSummaryReportRecovery(principalA, storage)).toEqual(
      binding,
    );
  });

  it('rejects mismatched, ineligible or malformed recovery data', () => {
    const invalidBindings = [
      {
        request,
        original: { ...original, bitableRecordId: 'recDifferent123456' },
        state: 'pending',
      },
      {
        request,
        original: { ...original, submitterName: '其他人' },
        state: 'pending',
      },
      { request, original, state: 'invalid' },
      { request, original, state: 'pending', taskId: 42 },
    ];

    for (const binding of invalidBindings) {
      storage.setItem(
        'monthly-schedule.change-summary-report.recovery.v3.principal-a-1234567890',
        JSON.stringify(binding),
      );
      expect(readChangeSummaryReportRecovery(principalA, storage)).toBeNull();
    }
  });

  it('never exposes another principal recovery namespace', () => {
    const binding: ChangeSummaryReportRecoveryBinding = {
      request,
      original: recoveryOriginal,
      state: 'pending',
      taskId: 'summary-task-1',
    };
    expect(
      persistChangeSummaryReportRecovery(binding, principalA, storage),
    ).toBe(true);

    expect(readChangeSummaryReportRecoveries(principalB, storage)).toEqual([]);
    expect(readChangeSummaryReportRecoveries(principalA, storage)).toEqual([
      binding,
    ]);
  });

  it('purges the legacy unscoped recovery key without exposing its contents', () => {
    const legacyKey = 'monthly-schedule.change-summary-report.recovery.v1';
    storage.setItem(
      legacyKey,
      JSON.stringify({ request, original, state: 'failed' }),
    );

    expect(readChangeSummaryReportRecoveries(principalA, storage)).toEqual([]);
    expect(values.has(legacyKey)).toBe(false);
  });

  it('bounds persisted recovery count and rejects oversized error payloads', () => {
    for (
      let index = 0;
      index < CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BINDINGS;
      index += 1
    ) {
      const suffix = String(index).padStart(12, '0');
      const recordId = `recBounded${String(index).padStart(8, '0')}`;
      const nextRequest = {
        ...request,
        clientMutationId: `change-summary-report-00000000-0000-4000-8000-${suffix}`,
        changeRecordId: recordId,
      };
      const nextOriginal = createChangeSummaryReportRecoveryOriginal({
        ...original,
        id: recordId,
        bitableRecordId: recordId,
      });
      expect(
        persistChangeSummaryReportRecovery(
          { request: nextRequest, original: nextOriginal, state: 'unknown' },
          principalA,
          storage,
        ),
      ).toBe(true);
    }

    expect(
      persistChangeSummaryReportRecovery(
        {
          request: {
            ...request,
            clientMutationId:
              'change-summary-report-ffffffff-ffff-4fff-8fff-ffffffffffff',
          },
          original: recoveryOriginal,
          state: 'failed',
          error: 'x'.repeat(5_000),
        },
        principalB,
        storage,
      ),
    ).toBe(false);
    expect(readChangeSummaryReportRecoveries(principalA, storage)).toHaveLength(
      CHANGE_SUMMARY_REPORT_RECOVERY_MAX_BINDINGS,
    );
  });

  it('clears recovery only after a known completed outcome', () => {
    persistChangeSummaryReportRecovery(
      {
        request,
        original: recoveryOriginal,
        state: 'pending',
        taskId: 'summary-task-1',
      },
      principalA,
      storage,
    );

    expect(clearChangeSummaryReportRecovery(principalA, storage)).toBe(true);
    expect(readChangeSummaryReportRecovery(principalA, storage)).toBeNull();
  });
});
