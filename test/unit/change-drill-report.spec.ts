import {
  CHANGE_DRILL_REPORT_MAX_DOCUMENT_COUNT,
  CHANGE_DRILL_REPORT_MAX_DOCUMENT_SIZE,
  CHANGE_DRILL_REPORT_MUTATION_ID_PREFIX,
  createEmptyChangeDrillReportDraft,
  parseChangeDrillReportPayload,
  validateChangeDrillReport,
  type ChangeDrillReportCreateRequest,
  type ChangeDrillReportCreateResponse,
  type ChangeDrillReportDraft,
} from '../../shared/change-drill-report';
import type { ChangeRequestStagedDocument } from '../../shared/change-request';

const VALID_MUTATION_ID =
  'change-drill-report-123e4567-e89b-42d3-a456-426614174000';

const validDocument = (
  patch: Partial<ChangeRequestStagedDocument> = {},
): ChangeRequestStagedDocument => ({
  name: '演练报告.pdf',
  type: 'application/pdf',
  size: 1024,
  objectStorage: {
    id: 'storage-file-1',
    filePath: 'change-drill-reports/report-1.pdf',
    bucketId: 'default-bucket',
    url: 'https://storage.example.test/change-drill-reports/report-1.pdf',
  },
  ...patch,
});

const validRequest = (): ChangeDrillReportCreateRequest => ({
  clientMutationId: VALID_MUTATION_ID,
  changeRecordId: 'recAbCdEf1234567890',
  buildings: ['A楼', 'E楼'],
  reportDocuments: [validDocument()],
});

const errorFields = (request: unknown) =>
  validateChangeDrillReport(request).map(({ field }) => field);

describe('change drill report shared contract', () => {
  it('exposes the canonical mutation id prefix', () => {
    expect(CHANGE_DRILL_REPORT_MUTATION_ID_PREFIX).toBe('change-drill-report-');
  });

  it('creates an empty draft without preselecting a change or building', () => {
    const draft: ChangeDrillReportDraft = createEmptyChangeDrillReportDraft();

    expect(draft).toEqual({
      changeRecordId: '',
      buildings: [],
      reportDocuments: [],
    });
  });

  it('parses object JSON and exposes the asynchronous response contract', () => {
    expect(
      parseChangeDrillReportPayload(JSON.stringify(validRequest())),
    ).toEqual(validRequest());

    const response: ChangeDrillReportCreateResponse = {
      success: true,
      clientMutationId: VALID_MUTATION_ID,
      reportRecordId: 'recReport1234567890',
      pendingSync: false,
      taskId: VALID_MUTATION_ID,
      message: '演练报告已同步',
    };
    expect(response.reportRecordId).toBe('recReport1234567890');
    expect(() => parseChangeDrillReportPayload('{broken')).toThrow(
      '演练报告 payload 不是有效 JSON',
    );
    expect(() => parseChangeDrillReportPayload('[]')).toThrow(
      '演练报告 payload 必须是 JSON 对象',
    );
  });

  it('accepts a complete request', () => {
    expect(validateChangeDrillReport(validRequest())).toEqual([]);
  });

  it('requires a canonical change-drill-report UUID mutation id', () => {
    for (const clientMutationId of [
      '',
      '123e4567-e89b-42d3-a456-426614174000',
      'change-drill-report-not-a-uuid',
      'change-drill-report-123e4567-e89b-02d3-a456-426614174000',
      'change-drill-report-123e4567-e89b-72d3-a456-426614174000',
    ]) {
      expect(errorFields({ ...validRequest(), clientMutationId })).toContain(
        'clientMutationId',
      );
    }

    expect(errorFields(validRequest())).not.toContain('clientMutationId');
  });

  it('requires a real Feishu rec* change record id', () => {
    for (const changeRecordId of [
      '',
      'rec',
      'rec-change-1',
      'local-change-1',
      'optimistic:change-1',
    ]) {
      expect(errorFields({ ...validRequest(), changeRecordId })).toContain(
        'changeRecordId',
      );
    }

    expect(errorFields(validRequest())).not.toContain('changeRecordId');
  });

  it('requires at least one unique building from the change request options', () => {
    expect(errorFields({ ...validRequest(), buildings: [] })).toContain(
      'buildings',
    );
    expect(errorFields({ ...validRequest(), buildings: ['F楼'] })).toContain(
      'buildings',
    );
    expect(
      errorFields({ ...validRequest(), buildings: ['A楼', 'A楼'] }),
    ).toContain('buildings');
    expect(
      errorFields({ ...validRequest(), buildings: ['A楼', '110站', 'H楼'] }),
    ).not.toContain('buildings');
  });

  it('requires one to five staged reports and caps each at 200 MiB', () => {
    expect(CHANGE_DRILL_REPORT_MAX_DOCUMENT_COUNT).toBe(5);
    expect(CHANGE_DRILL_REPORT_MAX_DOCUMENT_SIZE).toBe(200 * 1024 * 1024);
    expect(errorFields({ ...validRequest(), reportDocuments: [] })).toContain(
      'reportDocuments',
    );
    expect(
      errorFields({
        ...validRequest(),
        reportDocuments: Array.from({ length: 6 }, validDocument),
      }),
    ).toContain('reportDocuments');
    expect(
      errorFields({
        ...validRequest(),
        reportDocuments: [
          validDocument({ size: CHANGE_DRILL_REPORT_MAX_DOCUMENT_SIZE + 1 }),
        ],
      }),
    ).toContain('reportDocuments');
    expect(
      errorFields({
        ...validRequest(),
        reportDocuments: [
          validDocument({ size: CHANGE_DRILL_REPORT_MAX_DOCUMENT_SIZE }),
        ],
      }),
    ).not.toContain('reportDocuments');
  });

  it.each([
    ['报告.pdf', 'application/pdf'],
    ['报告.doc', 'application/msword'],
    [
      '报告.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['清单.xls', 'application/vnd.ms-excel'],
    [
      '清单.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['现场.png', 'image/png'],
    ['现场.jpg', 'image/jpeg'],
    ['现场.jpeg', 'image/jpeg'],
  ])('accepts the allowed report format %s', (name, type) => {
    expect(
      errorFields({
        ...validRequest(),
        reportDocuments: [validDocument({ name, type })],
      }),
    ).not.toContain('reportDocuments');
  });

  it('rejects unsupported or mismatched report formats', () => {
    expect(
      errorFields({
        ...validRequest(),
        reportDocuments: [
          validDocument({ name: '脚本.exe', type: 'application/octet-stream' }),
        ],
      }),
    ).toContain('reportDocuments');
    expect(
      errorFields({
        ...validRequest(),
        reportDocuments: [
          validDocument({ name: '伪装.pdf', type: 'application/x-msdownload' }),
        ],
      }),
    ).toContain('reportDocuments');
  });

  it('requires complete and safe object-storage metadata for every report', () => {
    for (const objectStorage of [
      undefined,
      {
        ...validDocument().objectStorage,
        id: '   ',
      },
      {
        ...validDocument().objectStorage,
        filePath: '',
      },
      {
        ...validDocument().objectStorage,
        bucketId: '',
      },
      {
        ...validDocument().objectStorage,
        url: 'javascript:alert(1)',
      },
    ]) {
      expect(
        errorFields({
          ...validRequest(),
          reportDocuments: [
            {
              ...validDocument(),
              objectStorage,
            },
          ],
        }),
      ).toContain('reportDocuments');
    }
  });

  it('rejects non-object payloads with a payload validation error', () => {
    expect(validateChangeDrillReport(null)).toEqual([
      { field: 'payload', message: '演练报告数据格式无效' },
    ]);
    expect(errorFields([])).toEqual(['payload']);
  });
});
