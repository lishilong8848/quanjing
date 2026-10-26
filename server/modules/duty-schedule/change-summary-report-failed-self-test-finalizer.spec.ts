import { createHmac } from 'node:crypto';

import {
  createFailedChangeSummarySelfTestCleanupProof,
  FAILED_CHANGE_SUMMARY_SELF_TEST_CLEANUP_PROOF_TTL_MS,
  type FailedChangeSummarySelfTestCleanupPorts,
  type FailedChangeSummarySelfTestCleanupRequest,
  finalizeFailedChangeSummarySelfTestCleanup,
} from './change-summary-report-failed-self-test-finalizer';

const NOW = Date.parse('2026-08-12T10:00:00+08:00');
const SECRET = Buffer.alloc(32, 7).toString('base64');

function request(
  patch: Partial<FailedChangeSummarySelfTestCleanupRequest> = {},
): FailedChangeSummarySelfTestCleanupRequest {
  return {
    changeRequestMutationId:
      'change-request-123e4567-e89b-42d3-a456-426614174000',
    clientMutationId:
      'change-summary-report-223e4567-e89b-42d3-a456-426614174001',
    changeRecordId: 'recChange12345678',
    summaryMarker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786500000000-deadbeef',
    summaryFingerprint: 'a'.repeat(64),
    changeObjectIds: ['storage-change-2', 'storage-change-1'],
    summaryObjectIds: ['storage-summary-2', 'storage-summary-1'],
    expiresAt: NOW + 60_000,
    ...patch,
  };
}

type FinalizeResult = { alreadyFinalized: boolean };

function ports(
  patch: Partial<FailedChangeSummarySelfTestCleanupPorts<FinalizeResult>> = {},
): jest.Mocked<FailedChangeSummarySelfTestCleanupPorts<FinalizeResult>> {
  return {
    readChangeRecordExact: jest.fn().mockResolvedValue(null),
    countChangeRecordsBySummaryMarker: jest.fn().mockResolvedValue(0),
    countSummaryReportsByMutationId: jest.fn().mockResolvedValue(0),
    countSummaryReportsByChangeRecordId: jest.fn().mockResolvedValue(0),
    getObjectDeletionState: jest.fn().mockResolvedValue('absent'),
    finalizeLedgers: jest.fn().mockResolvedValue({ alreadyFinalized: false }),
    ...patch,
  } as jest.Mocked<FailedChangeSummarySelfTestCleanupPorts<FinalizeResult>>;
}

function proof(value = request()): string {
  return createFailedChangeSummarySelfTestCleanupProof(value, SECRET);
}

function expectNoExternalReads(
  subject: jest.Mocked<FailedChangeSummarySelfTestCleanupPorts<FinalizeResult>>,
): void {
  expect(subject.readChangeRecordExact).not.toHaveBeenCalled();
  expect(subject.countChangeRecordsBySummaryMarker).not.toHaveBeenCalled();
  expect(subject.countSummaryReportsByMutationId).not.toHaveBeenCalled();
  expect(subject.countSummaryReportsByChangeRecordId).not.toHaveBeenCalled();
  expect(subject.getObjectDeletionState).not.toHaveBeenCalled();
  expect(subject.finalizeLedgers).not.toHaveBeenCalled();
}

describe('failed change-summary self-test cleanup finalizer', () => {
  it('uses the independent domain and canonical object ordering for its proof', () => {
    const value = request();
    const actual = proof(value);
    const expected = createHmac('sha256', Buffer.alloc(32, 7))
      .update(
        [
          'vnet-change-summary-report-failed-self-test-cleanup-v1',
          value.changeRequestMutationId,
          value.clientMutationId,
          value.changeRecordId,
          value.summaryMarker,
          value.summaryFingerprint,
          JSON.stringify([...value.changeObjectIds].sort()),
          JSON.stringify([...value.summaryObjectIds].sort()),
          String(value.expiresAt),
        ].join('\n'),
      )
      .digest('base64url');

    expect(actual).toBe(expected);
    expect(
      proof(
        request({
          changeObjectIds: [...value.changeObjectIds].reverse(),
          summaryObjectIds: [...value.summaryObjectIds].reverse(),
        }),
      ),
    ).toBe(actual);
  });

  it.each([
    [
      'expired',
      request({ expiresAt: NOW - 1 }),
      proof(request({ expiresAt: NOW - 1 })),
    ],
    [
      'too far in the future',
      request({
        expiresAt:
          NOW + FAILED_CHANGE_SUMMARY_SELF_TEST_CLEANUP_PROOF_TTL_MS + 1,
      }),
      proof(
        request({
          expiresAt:
            NOW + FAILED_CHANGE_SUMMARY_SELF_TEST_CLEANUP_PROOF_TTL_MS + 1,
        }),
      ),
    ],
    ['tampered', request({ summaryFingerprint: 'b'.repeat(64) }), proof()],
  ])(
    'rejects an %s proof before any external read',
    async (_name, body, token) => {
      const subject = ports();

      await expect(
        finalizeFailedChangeSummarySelfTestCleanup(
          body,
          token,
          SECRET,
          subject,
          NOW,
        ),
      ).rejects.toThrow('签名');
      expectNoExternalReads(subject);
    },
  );

  it.each([
    [
      'duplicate change object ids',
      { changeObjectIds: ['storage-change-1', 'storage-change-1'] },
    ],
    [
      'duplicate summary object ids',
      { summaryObjectIds: ['storage-summary-1', 'storage-summary-1'] },
    ],
    [
      'an object id shared by both arrays',
      {
        changeObjectIds: ['storage-shared-1'],
        summaryObjectIds: ['storage-shared-1'],
      },
    ],
  ])('rejects %s before any external read', async (_name, patch) => {
    const body = request(patch);
    const subject = ports();

    await expect(
      finalizeFailedChangeSummarySelfTestCleanup(
        body,
        'x'.repeat(43),
        SECRET,
        subject,
        NOW,
      ),
    ).rejects.toThrow('无效');
    expectNoExternalReads(subject);
  });

  it.each([
    [
      'the exact change record',
      { readChangeRecordExact: jest.fn().mockResolvedValue({ id: 'record' }) },
    ],
    [
      'a change marker match',
      { countChangeRecordsBySummaryMarker: jest.fn().mockResolvedValue(1) },
    ],
    [
      'a summary mutation match',
      { countSummaryReportsByMutationId: jest.fn().mockResolvedValue(1) },
    ],
    [
      'a summary relation match',
      { countSummaryReportsByChangeRecordId: jest.fn().mockResolvedValue(1) },
    ],
  ])('rejects Base residue from %s', async (_name, patch) => {
    const body = request();
    const subject = ports(patch);

    await expect(
      finalizeFailedChangeSummarySelfTestCleanup(
        body,
        proof(body),
        SECRET,
        subject,
        NOW,
      ),
    ).rejects.toThrow('仍然存在');
    expect(subject.finalizeLedgers).not.toHaveBeenCalled();
  });

  it.each(['present', 'cleanup-pending'])(
    'rejects a COS object in %s state',
    async (state) => {
      const body = request();
      const subject = ports({
        getObjectDeletionState: jest
          .fn()
          .mockImplementation(async (id) =>
            id === 'storage-summary-2' ? state : 'absent',
          ),
      });

      await expect(
        finalizeFailedChangeSummarySelfTestCleanup(
          body,
          proof(body),
          SECRET,
          subject,
          NOW,
        ),
      ).rejects.toThrow('COS');
      expect(subject.getObjectDeletionState).toHaveBeenCalledTimes(4);
      expect(subject.finalizeLedgers).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown Base and COS states instead of assuming absence', async () => {
    const baseBody = request();
    const unknownBase = ports({
      countSummaryReportsByMutationId: jest.fn().mockResolvedValue(undefined),
    });
    await expect(
      finalizeFailedChangeSummarySelfTestCleanup(
        baseBody,
        proof(baseBody),
        SECRET,
        unknownBase,
        NOW,
      ),
    ).rejects.toThrow('无法确认');
    expect(unknownBase.finalizeLedgers).not.toHaveBeenCalled();

    const unknownCos = ports({
      getObjectDeletionState: jest.fn().mockResolvedValue('unknown'),
    });
    await expect(
      finalizeFailedChangeSummarySelfTestCleanup(
        baseBody,
        proof(baseBody),
        SECRET,
        unknownCos,
        NOW,
      ),
    ).rejects.toThrow('无法确认');
    expect(unknownCos.finalizeLedgers).not.toHaveBeenCalled();
  });

  it('finalizes only after every external state is absent and passes normalized input through', async () => {
    const body = request();
    const subject = ports();

    await expect(
      finalizeFailedChangeSummarySelfTestCleanup(
        body,
        proof(body),
        SECRET,
        subject,
        NOW,
      ),
    ).resolves.toEqual({ alreadyFinalized: false });
    expect(subject.getObjectDeletionState).toHaveBeenCalledTimes(4);
    expect(subject.finalizeLedgers).toHaveBeenCalledWith({
      ...body,
      changeObjectIds: [...body.changeObjectIds].sort(),
      summaryObjectIds: [...body.summaryObjectIds].sort(),
    });
  });

  it('passes an idempotent ledger-finalizer result through on retry', async () => {
    const body = request();
    const subject = ports({
      finalizeLedgers: jest
        .fn()
        .mockResolvedValueOnce({ alreadyFinalized: false })
        .mockResolvedValueOnce({ alreadyFinalized: true }),
    });

    const first = await finalizeFailedChangeSummarySelfTestCleanup(
      body,
      proof(body),
      SECRET,
      subject,
      NOW,
    );
    const second = await finalizeFailedChangeSummarySelfTestCleanup(
      body,
      proof(body),
      SECRET,
      subject,
      NOW,
    );

    expect(first).toEqual({ alreadyFinalized: false });
    expect(second).toEqual({ alreadyFinalized: true });
    expect(subject.finalizeLedgers).toHaveBeenCalledTimes(2);
  });
});
