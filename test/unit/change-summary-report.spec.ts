import {
  CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_COUNT,
  CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_SIZE,
  CHANGE_SUMMARY_REPORT_MUTATION_ID_PREFIX,
  CHANGE_SUMMARY_REPORT_SUBMITTER_NAME_MAX_LENGTH,
  createEmptyChangeSummaryReportDraft,
  parseChangeSummaryReportPayload,
  validateChangeSummaryReport,
  type ChangeSummaryReportCreateRequest,
  type ChangeSummaryReportCreateResponse,
  type ChangeSummaryReportDraft,
} from '../../shared/change-summary-report';
import type { ChangeRequestStagedDocument } from '../../shared/change-request';

const VALID_MUTATION_ID =
  'change-summary-report-123e4567-e89b-42d3-a456-426614174000';

const validDocument = (
  patch: Partial<ChangeRequestStagedDocument> = {},
): ChangeRequestStagedDocument => ({
  name: '变更总结报告.pdf',
  type: 'application/pdf',
  size: 1024,
  objectStorage: {
    id: 'storage-file-1',
    filePath: 'change-summary-reports/report-1.pdf',
    bucketId: 'default-bucket',
    url: 'https://storage.example.test/change-summary-reports/report-1.pdf',
  },
  ...patch,
});

const validRequest = (): ChangeSummaryReportCreateRequest => ({
  clientMutationId: VALID_MUTATION_ID,
  submitterName: '示例人员020',
  changeRecordId: 'recAbCdEf1234567890',
  summaryDocuments: [validDocument()],
});

const errorFields = (request: unknown) =>
  validateChangeSummaryReport(request).map(({ field }) => field);

describe('change summary report shared contract', () => {
  it('exposes its limits, prefix and an unselected empty draft', () => {
    expect(CHANGE_SUMMARY_REPORT_MUTATION_ID_PREFIX).toBe(
      'change-summary-report-',
    );
    expect(CHANGE_SUMMARY_REPORT_SUBMITTER_NAME_MAX_LENGTH).toBe(64);
    expect(CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_COUNT).toBe(5);
    expect(CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_SIZE).toBe(200 * 1024 * 1024);

    const draft: ChangeSummaryReportDraft =
      createEmptyChangeSummaryReportDraft();
    expect(draft).toEqual({
      submitterName: '',
      changeRecordId: '',
      summaryDocuments: [],
    });
  });

  it('parses object JSON and exposes the asynchronous response contract', () => {
    expect(
      parseChangeSummaryReportPayload(JSON.stringify(validRequest())),
    ).toEqual(validRequest());

    const response: ChangeSummaryReportCreateResponse = {
      success: true,
      clientMutationId: VALID_MUTATION_ID,
      changeRecordId: validRequest().changeRecordId,
      summaryReportRecordId: 'recSummary12345678',
      pendingSync: false,
      taskId: VALID_MUTATION_ID,
      message: '变更总结已同步',
    };
    expect(response.summaryReportRecordId).toBe('recSummary12345678');
    expect(() => parseChangeSummaryReportPayload('{broken')).toThrow(
      '变更总结 payload 不是有效 JSON',
    );
    expect(() => parseChangeSummaryReportPayload('[]')).toThrow(
      '变更总结 payload 必须是 JSON 对象',
    );
  });

  it('rejects incomplete or wrongly typed objects while parsing', () => {
    expect(() => parseChangeSummaryReportPayload({})).toThrow(
      '请求标识必须是 change-summary-report-UUID',
    );
    expect(() =>
      parseChangeSummaryReportPayload({
        ...validRequest(),
        submitterName: 42,
      }),
    ).toThrow('请选择变更提交人');
    expect(() =>
      parseChangeSummaryReportPayload({
        ...validRequest(),
        summaryDocuments: 'not-an-array',
      }),
    ).toThrow('请上传 1-5 个变更总结文档');
  });

  it('returns a normalized request with detached staged-document metadata', () => {
    const source = {
      ...validRequest(),
      clientMutationId: `  ${VALID_MUTATION_ID}  `,
      submitterName: '  示例人员020  ',
      changeRecordId: '  recAbCdEf1234567890  ',
      summaryDocuments: [
        {
          ...validDocument(),
          name: '  变更总结报告.pdf  ',
          type: '  application/pdf  ',
          objectStorage: {
            id: '  storage-file-1  ',
            filePath: '  change-summary-reports/report-1.pdf  ',
            bucketId: '  default-bucket  ',
            url: '  https://storage.example.test/change-summary-reports/report-1.pdf  ',
          },
          ignored: 'must not escape the parser',
        },
      ],
      ignored: 'must not escape the parser',
    };

    const parsed = parseChangeSummaryReportPayload(source);

    expect(parsed).toEqual(validRequest());
    expect(parsed).not.toBe(source);
    expect(parsed.summaryDocuments).not.toBe(source.summaryDocuments);
    expect(parsed.summaryDocuments[0]).not.toBe(source.summaryDocuments[0]);
    expect(parsed.summaryDocuments[0].objectStorage).not.toBe(
      source.summaryDocuments[0].objectStorage,
    );

    source.summaryDocuments[0].objectStorage.id = 'changed-after-parse';
    expect(parsed.summaryDocuments[0].objectStorage.id).toBe('storage-file-1');
  });

  it('normalizes submitter names with NFKC and edge trim without collapsing internal whitespace', () => {
    const parsed = parseChangeSummaryReportPayload({
      ...validRequest(),
      submitterName: '  Ａ　Ｂ  ',
    });

    expect(parsed.submitterName).toBe('A B');
  });

  it('accepts a complete request', () => {
    expect(validateChangeSummaryReport(validRequest())).toEqual([]);
  });

  it('requires a canonical change-summary-report v4 UUID mutation id', () => {
    for (const clientMutationId of [
      '',
      '123e4567-e89b-42d3-a456-426614174000',
      'change-summary-report-not-a-uuid',
      'change-summary-report-123e4567-e89b-02d3-a456-426614174000',
      'change-summary-report-123e4567-e89b-72d3-a456-426614174000',
      'change-summary-report-123e4567-e89b-42d3-7456-426614174000',
    ]) {
      expect(errorFields({ ...validRequest(), clientMutationId })).toContain(
        'clientMutationId',
      );
    }

    expect(errorFields(validRequest())).not.toContain('clientMutationId');
  });

  it('requires a trimmed submitter name of 1-64 Unicode characters', () => {
    expect(
      errorFields({ ...validRequest(), submitterName: '  示例人员020  ' }),
    ).not.toContain('submitterName');
    expect(errorFields({ ...validRequest(), submitterName: '   ' })).toContain(
      'submitterName',
    );
    expect(
      errorFields({ ...validRequest(), submitterName: '马'.repeat(64) }),
    ).not.toContain('submitterName');
    expect(
      errorFields({ ...validRequest(), submitterName: '😀'.repeat(64) }),
    ).not.toContain('submitterName');
    expect(
      errorFields({ ...validRequest(), submitterName: '马'.repeat(65) }),
    ).toContain('submitterName');
  });

  it('requires a real Feishu rec* change record id', () => {
    for (const changeRecordId of [
      '',
      'rec',
      'rec-change-1',
      'local-change-1',
      'change-request-pending-1',
    ]) {
      expect(errorFields({ ...validRequest(), changeRecordId })).toContain(
        'changeRecordId',
      );
    }

    expect(errorFields(validRequest())).not.toContain('changeRecordId');
  });

  it('requires one to five staged documents and caps each at 200 MiB', () => {
    expect(errorFields({ ...validRequest(), summaryDocuments: [] })).toContain(
      'summaryDocuments',
    );
    expect(
      errorFields({
        ...validRequest(),
        summaryDocuments: Array.from({ length: 6 }, (_, index) =>
          validDocument({
            objectStorage: {
              ...validDocument().objectStorage,
              id: `storage-file-${index}`,
              filePath: `change-summary-reports/report-${index}.pdf`,
              url: `https://storage.example.test/change-summary-reports/report-${index}.pdf`,
            },
          }),
        ),
      }),
    ).toContain('summaryDocuments');
    expect(
      errorFields({
        ...validRequest(),
        summaryDocuments: [
          validDocument({
            size: CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_SIZE + 1,
          }),
        ],
      }),
    ).toContain('summaryDocuments');
    expect(
      errorFields({
        ...validRequest(),
        summaryDocuments: [
          validDocument({ size: CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_SIZE }),
        ],
      }),
    ).not.toContain('summaryDocuments');
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
  ])('accepts the allowed summary format %s', (name, type) => {
    expect(
      errorFields({
        ...validRequest(),
        summaryDocuments: [validDocument({ name, type })],
      }),
    ).not.toContain('summaryDocuments');
  });

  it('rejects unsupported or MIME-mismatched documents', () => {
    expect(
      errorFields({
        ...validRequest(),
        summaryDocuments: [
          validDocument({ name: '脚本.exe', type: 'application/octet-stream' }),
        ],
      }),
    ).toContain('summaryDocuments');
    expect(
      errorFields({
        ...validRequest(),
        summaryDocuments: [
          validDocument({ name: '伪装.pdf', type: 'application/x-msdownload' }),
        ],
      }),
    ).toContain('summaryDocuments');
  });

  it.each([
    ['name', 42],
    ['type', { mime: 'application/pdf' }],
    ['originalname', ['变更总结报告.pdf']],
    ['mimetype', true],
  ])(
    'returns a document validation error when optional field %s is not a string',
    (field, value) => {
      const request = {
        ...validRequest(),
        summaryDocuments: [
          {
            ...validDocument(),
            [field]: value,
          },
        ],
      };

      expect(() => validateChangeSummaryReport(request)).not.toThrow();
      expect(errorFields(request)).toContain('summaryDocuments');
    },
  );

  it('requires complete safe COS metadata and rejects duplicate attachments', () => {
    for (const objectStorage of [
      undefined,
      { ...validDocument().objectStorage, id: '   ' },
      { ...validDocument().objectStorage, filePath: '' },
      { ...validDocument().objectStorage, bucketId: '' },
      {
        ...validDocument().objectStorage,
        url: 'http://storage.example.test/report.pdf',
      },
      {
        ...validDocument().objectStorage,
        url: 'https://127.0.0.1/report.pdf',
      },
    ]) {
      expect(
        errorFields({
          ...validRequest(),
          summaryDocuments: [{ ...validDocument(), objectStorage }],
        }),
      ).toContain('summaryDocuments');
    }

    expect(
      errorFields({
        ...validRequest(),
        summaryDocuments: [validDocument(), validDocument()],
      }),
    ).toContain('summaryDocuments');
  });

  it.each([
    [
      'the same object-storage id',
      {
        id: 'storage-file-1',
        filePath: 'change-summary-reports/report-2.pdf',
        bucketId: 'default-bucket',
        url: 'https://storage.example.test/change-summary-reports/report-2.pdf',
      },
    ],
    [
      'the same bucket and object path',
      {
        id: 'storage-file-2',
        filePath: 'change-summary-reports/report-1.pdf',
        bucketId: 'default-bucket',
        url: 'https://storage.example.test/change-summary-reports/report-2.pdf',
      },
    ],
    [
      'the same safe URL',
      {
        id: 'storage-file-2',
        filePath: 'change-summary-reports/report-2.pdf',
        bucketId: 'default-bucket',
        url: 'https://storage.example.test/change-summary-reports/report-1.pdf',
      },
    ],
    [
      'the same references surrounded by whitespace',
      {
        id: '  storage-file-1  ',
        filePath: '  change-summary-reports/report-1.pdf  ',
        bucketId: '  default-bucket  ',
        url: '  https://storage.example.test/change-summary-reports/report-1.pdf  ',
      },
    ],
  ])('rejects duplicate attachments by %s', (_label, objectStorage) => {
    expect(
      errorFields({
        ...validRequest(),
        summaryDocuments: [validDocument(), validDocument({ objectStorage })],
      }),
    ).toContain('summaryDocuments');
  });

  it('rejects non-object payloads with a typed payload error', () => {
    expect(validateChangeSummaryReport(null)).toEqual([
      { field: 'payload', message: '变更总结数据格式无效' },
    ]);
    expect(errorFields([])).toEqual(['payload']);
  });
});
