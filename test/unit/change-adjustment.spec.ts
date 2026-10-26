import {
  CHANGE_ADJUSTMENT_EVIDENCE_MAX_COUNT,
  CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE,
  CHANGE_ADJUSTMENT_REASON_MAX_LENGTH,
  createEmptyChangeAdjustmentDraft,
  validateChangeAdjustment,
  type ChangeAdjustmentFileInput,
  type ChangeAdjustmentRequest,
  type ChangeAdjustmentValidationContext,
} from '../../shared/change-adjustment';
import { CHANGE_REQUEST_MAX_DOCUMENT_SIZE } from '../../shared/change-request';

const VALID_MUTATION_ID =
  'change-adjustment-123e4567-e89b-42d3-a456-426614174000';

const storage = (patch: Record<string, unknown> = {}) => ({
  id: 'storage-file-1',
  filePath: 'change-schemes/record-1/plan.pdf',
  bucketId: 'default-bucket',
  url: 'https://storage.example.test/change-schemes/record-1/plan.pdf',
  ...patch,
});

const scheme = (
  patch: Partial<ChangeAdjustmentFileInput> = {},
): ChangeAdjustmentFileInput => ({
  name: '最新变更方案.pdf',
  type: 'application/pdf',
  size: 1024,
  objectStorage: storage(),
  ...patch,
});

const evidence = (
  patch: Partial<ChangeAdjustmentFileInput> = {},
): ChangeAdjustmentFileInput => ({
  name: '延期举证.png',
  type: 'image/png',
  size: 1024,
  objectStorage: storage({
    id: 'evidence-1',
    filePath: 'change-adjustments/record-1/evidence.png',
    url: 'https://storage.example.test/change-adjustments/record-1/evidence.png',
  }),
  ...patch,
});

const notStartedContext = (
  patch: Partial<ChangeAdjustmentValidationContext> = {},
): ChangeAdjustmentValidationContext => ({
  lifecycleStatus: 'not-started',
  effectiveStartDate: '2026-08-10T09:00',
  effectiveEndDate: '2026-08-10T18:00',
  ...patch,
});

const validNotStartedRequest = (
  patch: Partial<ChangeAdjustmentRequest> = {},
): ChangeAdjustmentRequest => ({
  clientMutationId: VALID_MUTATION_ID,
  recordId: 'rec-change-1',
  expectedUpdatedAt: '2026-08-09T08:00:00.000Z',
  plannedDelayStartDate: '2026-08-10T10:00',
  plannedDelayEndDate: '2026-08-10T20:00',
  reason: '现场作业窗口调整',
  retainedDocumentTokens: ['base-plan-token'],
  removedDocumentTokens: [],
  newSchemeDocuments: [],
  evidenceDocuments: [evidence()],
  ...patch,
});

const fields = (
  request: unknown,
  context: ChangeAdjustmentValidationContext = notStartedContext(),
) => validateChangeAdjustment(request, context).map(({ field }) => field);

describe('change adjustment shared contract', () => {
  it('creates an empty draft without inventing a date, reason or attachment', () => {
    expect(createEmptyChangeAdjustmentDraft()).toEqual({
      recordId: '',
      expectedUpdatedAt: '',
      expectedVersion: undefined,
      plannedDelayStartDate: '',
      plannedDelayEndDate: '',
      reason: '',
      retainedDocumentTokens: [],
      removedDocumentTokens: [],
      newSchemeDocuments: [],
      evidenceDocuments: [],
    });
  });

  it('accepts a complete not-started adjustment and a version-only request', () => {
    expect(
      validateChangeAdjustment(validNotStartedRequest(), notStartedContext()),
    ).toEqual([]);
    expect(
      fields(
        validNotStartedRequest({
          expectedUpdatedAt: undefined,
          expectedVersion: 'version-8',
        }),
      ),
    ).not.toContain('expectedVersion');
  });

  it('requires a canonical UUID mutation id, record id and optimistic version', () => {
    const invalid = validNotStartedRequest({
      clientMutationId: 'change-adjustment-not-a-uuid',
      recordId: '   ',
      expectedUpdatedAt: undefined,
      expectedVersion: undefined,
    });
    expect(fields(invalid)).toEqual(
      expect.arrayContaining([
        'clientMutationId',
        'recordId',
        'expectedVersion',
      ]),
    );
  });

  it('allows a not-started change to adjust both dates and requires both', () => {
    expect(
      fields(validNotStartedRequest({ plannedDelayStartDate: '' })),
    ).toContain('plannedDelayStartDate');
    expect(
      fields(validNotStartedRequest({ plannedDelayEndDate: '' })),
    ).toContain('plannedDelayEndDate');
    expect(
      fields(
        validNotStartedRequest({
          plannedDelayStartDate: '2026-08-11T09:00',
          plannedDelayEndDate: '2026-08-11T18:00',
        }),
      ),
    ).not.toEqual(
      expect.arrayContaining(['plannedDelayStartDate', 'plannedDelayEndDate']),
    );
  });

  it('allows an in-progress change to adjust only its end', () => {
    const context = notStartedContext({ lifecycleStatus: 'in-progress' });
    const valid = validNotStartedRequest({
      plannedDelayStartDate: null,
      plannedDelayEndDate: '2026-08-10T21:00',
    });
    expect(validateChangeAdjustment(valid, context)).toEqual([]);
    expect(
      fields({ ...valid, plannedDelayStartDate: '2026-08-10T10:00' }, context),
    ).toContain('plannedDelayStartDate');
  });

  it('rejects finished changes and requires end strictly after effective start', () => {
    expect(
      fields(
        validNotStartedRequest(),
        notStartedContext({ lifecycleStatus: 'finished' }),
      ),
    ).toContain('lifecycleStatus');
    expect(
      fields(
        validNotStartedRequest({
          plannedDelayStartDate: null,
          plannedDelayEndDate: '2026-08-10T09:00',
        }),
        notStartedContext({ lifecycleStatus: 'in-progress' }),
      ),
    ).toContain('plannedDelayEndDate');
    expect(
      fields(
        validNotStartedRequest({
          plannedDelayStartDate: '2026-08-10T20:00',
          plannedDelayEndDate: '2026-08-10T20:00',
        }),
      ),
    ).toContain('plannedDelayEndDate');
  });

  it('requires a reason of at most 1000 Unicode characters and evidence', () => {
    expect(CHANGE_ADJUSTMENT_REASON_MAX_LENGTH).toBe(1000);
    expect(fields(validNotStartedRequest({ reason: '  ' }))).toContain(
      'reason',
    );
    expect(
      fields(validNotStartedRequest({ reason: '延'.repeat(1001) })),
    ).toContain('reason');
    expect(fields(validNotStartedRequest({ evidenceDocuments: [] }))).toContain(
      'evidenceDocuments',
    );
  });

  it('keeps one to five scheme documents with a 200 MiB per-file limit', () => {
    expect(CHANGE_REQUEST_MAX_DOCUMENT_SIZE).toBe(200 * 1024 * 1024);
    expect(
      fields(
        validNotStartedRequest({
          retainedDocumentTokens: [],
          newSchemeDocuments: [],
        }),
      ),
    ).toContain('newSchemeDocuments');
    expect(
      fields(
        validNotStartedRequest({
          retainedDocumentTokens: ['one', 'two', 'three', 'four', 'five'],
          newSchemeDocuments: [scheme()],
        }),
      ),
    ).toContain('newSchemeDocuments');
    expect(
      fields(
        validNotStartedRequest({
          retainedDocumentTokens: [],
          newSchemeDocuments: [
            scheme({ size: CHANGE_REQUEST_MAX_DOCUMENT_SIZE + 1 }),
          ],
        }),
      ),
    ).toContain('newSchemeDocuments');
  });

  it('requires non-empty unique tokens and forbids retained/removed overlap', () => {
    expect(
      fields(
        validNotStartedRequest({ retainedDocumentTokens: ['valid', '  '] }),
      ),
    ).toContain('retainedDocumentTokens');
    expect(
      fields(
        validNotStartedRequest({
          retainedDocumentTokens: ['same'],
          removedDocumentTokens: ['same'],
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'retainedDocumentTokens',
        'removedDocumentTokens',
      ]),
    );
  });

  it('requires retained and removed tokens to belong to the available record tokens', () => {
    const context = notStartedContext({
      availableDocumentTokens: ['keep', 'remove'],
    });
    expect(
      validateChangeAdjustment(
        validNotStartedRequest({
          retainedDocumentTokens: ['keep'],
          removedDocumentTokens: ['remove'],
        }),
        context,
      ),
    ).toEqual([]);
    expect(
      fields(
        validNotStartedRequest({ retainedDocumentTokens: ['unknown'] }),
        context,
      ),
    ).toContain('retainedDocumentTokens');
    expect(
      fields(
        validNotStartedRequest({ removedDocumentTokens: ['unknown'] }),
        context,
      ),
    ).toContain('removedDocumentTokens');
  });

  it('fails closed when the authoritative effective range is invalid', () => {
    for (const context of [
      notStartedContext({ effectiveStartDate: 'invalid' }),
      notStartedContext({ effectiveEndDate: 'invalid' }),
      notStartedContext({
        effectiveStartDate: '2026-08-10T18:00',
        effectiveEndDate: '2026-08-10T18:00',
      }),
      notStartedContext({
        effectiveStartDate: '2026-08-10T19:00',
        effectiveEndDate: '2026-08-10T18:00',
      }),
    ]) {
      expect(fields(validNotStartedRequest(), context)).toContain(
        'lifecycleStatus',
      );
    }
  });

  it('validates object-storage metadata for each newly uploaded file', () => {
    expect(
      fields(
        validNotStartedRequest({
          retainedDocumentTokens: [],
          newSchemeDocuments: [
            scheme({ objectStorage: storage({ filePath: '   ' }) }),
          ],
        }),
      ),
    ).toContain('newSchemeDocuments');
    expect(
      fields(
        validNotStartedRequest({
          evidenceDocuments: [
            evidence({
              objectStorage: storage({ url: 'javascript:alert(1)' }),
            }),
          ],
        }),
      ),
    ).toContain('evidenceDocuments');
    expect(
      fields(
        validNotStartedRequest({
          evidenceDocuments: [
            evidence({
              objectStorage: storage({ url: 'https://10.0.0.8/evidence.png' }),
            }),
          ],
        }),
      ),
    ).toContain('evidenceDocuments');
  });

  it('limits evidence to five image/PDF files of 20 MiB each', () => {
    expect(CHANGE_ADJUSTMENT_EVIDENCE_MAX_COUNT).toBe(5);
    expect(CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE).toBe(20 * 1024 * 1024);
    expect(
      fields(
        validNotStartedRequest({
          evidenceDocuments: Array.from({ length: 6 }, () => evidence()),
        }),
      ),
    ).toContain('evidenceDocuments');
    expect(
      fields(
        validNotStartedRequest({
          evidenceDocuments: [
            evidence({ size: CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE + 1 }),
          ],
        }),
      ),
    ).toContain('evidenceDocuments');
    expect(
      fields(
        validNotStartedRequest({
          evidenceDocuments: [scheme({ name: '举证.docx' })],
        }),
      ),
    ).toContain('evidenceDocuments');
  });
});
