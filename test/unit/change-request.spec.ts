import {
  CHANGE_REQUEST_BUILDINGS,
  CHANGE_REQUEST_DISCIPLINES,
  CHANGE_REQUEST_LEVELS,
  CHANGE_REQUEST_NATURES,
  CHANGE_REQUEST_TYPES,
  CHANGE_REQUEST_WORK_TYPES,
  CHANGE_REQUEST_MAX_DOCUMENT_COUNT,
  CHANGE_REQUEST_MAX_DOCUMENT_SIZE,
  createEmptyChangeRequestDraft,
  isSafeChangeAttachmentUrl,
  parseChangeRequestPayload,
  validateChangeRequest,
  type ChangeRequestCreateRequest,
  type ChangeRequestCreateResponse,
  type ChangeRequestDocumentInput,
  type ChangeRequestDraft,
  type ChangeRequestStagedDocument,
} from '../../shared/change-request';

const VALID_MUTATION_ID = 'change-request-123e4567-e89b-42d3-a456-426614174000';

const validRequest = (): ChangeRequestCreateRequest => ({
  clientMutationId: VALID_MUTATION_ID,
  submitterName: '马进宇',
  nature: '标准变更',
  summary: 'UPS 年度维护',
  changeType: '计划性变更',
  workType: '维护',
  buildings: ['A楼'],
  plannedStartAt: '2026-08-03T09:00',
  plannedEndAt: '2026-08-03T12:00',
  discipline: '电气',
  level: '低',
  riskSummary: '切换前确认旁路供电正常',
});

const validDocument = (
  patch: Partial<ChangeRequestDocumentInput> = {},
): ChangeRequestDocumentInput => ({
  name: '变更方案.pdf',
  type: 'application/pdf',
  size: 1024,
  ...patch,
});

const validStagedDocument = (
  patch: Partial<ChangeRequestStagedDocument> = {},
): ChangeRequestStagedDocument => ({
  name: '变更方案.pdf',
  type: 'application/pdf',
  size: 1024,
  objectStorage: {
    id: 'storage-file-1',
    filePath: 'change-schemes/record-1/plan.pdf',
    bucketId: 'default-bucket',
    url: 'https://storage.example.test/change-schemes/record-1/plan.pdf',
  },
  ...patch,
});

const errorFields = (
  request: unknown,
  documents: readonly ChangeRequestDocumentInput[] = [validDocument()],
) => validateChangeRequest(request, { documents }).map(({ field }) => field);

describe('change request shared contract', () => {
  it('keeps every option from the old Feishu form exact and ordered', () => {
    expect(CHANGE_REQUEST_NATURES).toEqual(['标准变更', '非标准变更']);
    expect(CHANGE_REQUEST_TYPES).toEqual(['计划性变更', '紧急变更']);
    expect(CHANGE_REQUEST_WORK_TYPES).toEqual([
      '维护',
      '检修',
      '施工',
      '其他',
      '升级改善',
    ]);
    expect(CHANGE_REQUEST_BUILDINGS).toEqual([
      'A楼',
      'B楼',
      'C楼',
      'D楼',
      'E楼',
      '110站',
      'H楼',
    ]);
    expect(CHANGE_REQUEST_DISCIPLINES).toEqual([
      '电气',
      '暖通',
      '弱电',
      '消防',
      '其他',
    ]);
    expect(CHANGE_REQUEST_LEVELS).toEqual(['高', '中', '低', '超低']);
  });

  it('creates an empty draft without silently preselecting form options', () => {
    const draft: ChangeRequestDraft = createEmptyChangeRequestDraft();

    expect(draft).toEqual({
      submitterName: '',
      stagedDocuments: [],
      nature: undefined,
      meetingStartAt: '',
      meetingEndAt: '',
      summary: '',
      changeType: undefined,
      workType: undefined,
      buildings: [],
      plannedStartAt: '',
      plannedEndAt: '',
      discipline: undefined,
      level: undefined,
      riskSummary: '',
    });
  });

  it('parses a JSON object payload and exposes the response contract', () => {
    const parsed = parseChangeRequestPayload(JSON.stringify(validRequest()));
    const response: ChangeRequestCreateResponse | undefined = undefined;

    expect(parsed).toEqual(validRequest());
    expect(response).toBeUndefined();
    expect(() => parseChangeRequestPayload('{broken')).toThrow(
      '变更申请 payload 不是有效 JSON',
    );
    expect(() => parseChangeRequestPayload('[]')).toThrow(
      '变更申请 payload 必须是 JSON 对象',
    );
    expect(() => parseChangeRequestPayload('null')).toThrow(
      '变更申请 payload 必须是 JSON 对象',
    );
  });

  it('accepts a complete standard change request', () => {
    expect(
      validateChangeRequest(validRequest(), { documents: [validDocument()] }),
    ).toEqual([]);
  });

  it('requires a canonical change-request UUID mutation id', () => {
    for (const clientMutationId of [
      '',
      '123e4567-e89b-42d3-a456-426614174000',
      'change-request-not-a-uuid',
      'change-request-123e4567-e89b-02d3-a456-426614174000',
      'change-request-123e4567-e89b-72d3-a456-426614174000',
    ]) {
      expect(errorFields({ ...validRequest(), clientMutationId })).toContain(
        'clientMutationId',
      );
    }

    expect(errorFields(validRequest())).not.toContain('clientMutationId');
  });

  it('reports every required field without trusting the request type', () => {
    const fields = errorFields({
      clientMutationId: VALID_MUTATION_ID,
      nature: '',
      summary: '   ',
      changeType: '',
      workType: '',
      buildings: [],
      plannedStartAt: '',
      plannedEndAt: '',
      discipline: '',
      level: '',
      riskSummary: '',
    });

    expect(fields).toEqual(
      expect.arrayContaining([
        'nature',
        'submitterName',
        'summary',
        'changeType',
        'workType',
        'buildings',
        'plannedStartAt',
        'plannedEndAt',
        'discipline',
        'level',
        'riskSummary',
      ]),
    );
  });

  it('requires a trimmed submitter name of at most 64 Unicode characters', () => {
    expect(errorFields({ ...validRequest(), submitterName: '   ' })).toContain(
      'submitterName',
    );
    expect(
      errorFields({
        ...validRequest(),
        submitterName: `  ${'马'.repeat(64)}  `,
      }),
    ).not.toContain('submitterName');
    expect(
      errorFields({ ...validRequest(), submitterName: '😀'.repeat(65) }),
    ).toContain('submitterName');
  });

  it('rejects values outside the exact Feishu option sets', () => {
    const fields = errorFields({
      ...validRequest(),
      nature: '普通变更',
      changeType: '日常变更',
      workType: '巡检',
      buildings: ['F楼'],
      discipline: '综合',
      level: '一般',
    });

    expect(fields).toEqual(
      expect.arrayContaining([
        'nature',
        'changeType',
        'workType',
        'buildings',
        'discipline',
        'level',
      ]),
    );
  });

  it('validates local timestamps and requires planned end after start', () => {
    expect(
      errorFields({ ...validRequest(), plannedStartAt: '2026-02-30T09:00' }),
    ).toContain('plannedStartAt');
    expect(
      errorFields({ ...validRequest(), plannedEndAt: '2026-08-03T09:00' }),
    ).toContain('plannedEndAt');
    expect(
      errorFields({ ...validRequest(), plannedEndAt: '2026-08-03T08:59' }),
    ).toContain('plannedEndAt');
    expect(
      errorFields({ ...validRequest(), plannedEndAt: '2026-08-03 12:00' }),
    ).toContain('plannedEndAt');
  });

  it('requires meeting start only for non-standard changes and orders its range', () => {
    expect(errorFields({ ...validRequest(), nature: '非标准变更' })).toContain(
      'meetingStartAt',
    );

    expect(
      errorFields({
        ...validRequest(),
        nature: '非标准变更',
        meetingStartAt: '2026-08-02T10:00',
      }),
    ).not.toContain('meetingStartAt');

    expect(
      errorFields({
        ...validRequest(),
        nature: '非标准变更',
        meetingStartAt: '2026-08-02T10:00',
        meetingEndAt: '2026-08-02T10:00',
      }),
    ).toContain('meetingEndAt');

    expect(
      errorFields({
        ...validRequest(),
        nature: '非标准变更',
        meetingStartAt: '2026-08-02T10:00',
        meetingEndAt: '2026-08-02T11:00',
      }),
    ).not.toEqual(expect.arrayContaining(['meetingStartAt', 'meetingEndAt']));
  });

  it('enforces the form text limits by Unicode character count', () => {
    expect(
      errorFields({ ...validRequest(), summary: '变'.repeat(500) }),
    ).not.toContain('summary');
    expect(
      errorFields({ ...validRequest(), summary: '变'.repeat(501) }),
    ).toContain('summary');
    expect(
      errorFields({ ...validRequest(), riskSummary: '险'.repeat(2000) }),
    ).not.toContain('riskSummary');
    expect(
      errorFields({ ...validRequest(), riskSummary: '险'.repeat(2001) }),
    ).toContain('riskSummary');
    expect(
      errorFields({ ...validRequest(), summary: '😀'.repeat(500) }),
    ).not.toContain('summary');
  });

  it('requires one to five documents and caps each scheme file at 200 MiB', () => {
    expect(CHANGE_REQUEST_MAX_DOCUMENT_COUNT).toBe(5);
    expect(CHANGE_REQUEST_MAX_DOCUMENT_SIZE).toBe(200 * 1024 * 1024);
    expect(
      validateChangeRequest(validRequest(), { documentCount: 0 }).map(
        ({ field }) => field,
      ),
    ).toContain('documents');
    expect(
      errorFields(validRequest(), Array.from({ length: 6 }, validDocument)),
    ).toContain('documents');
    expect(
      errorFields(validRequest(), [
        validDocument({ size: CHANGE_REQUEST_MAX_DOCUMENT_SIZE + 1 }),
      ]),
    ).toContain('documents');
    expect(
      errorFields(validRequest(), [
        validDocument({ size: CHANGE_REQUEST_MAX_DOCUMENT_SIZE }),
      ]),
    ).not.toContain('documents');
  });

  it('validates staged object-storage documents when no File context is supplied', () => {
    expect(
      validateChangeRequest({
        ...validRequest(),
        stagedDocuments: [validStagedDocument()],
      }),
    ).toEqual([]);
    expect(
      validateChangeRequest({ ...validRequest(), stagedDocuments: [] }).map(
        ({ field }) => field,
      ),
    ).toContain('documents');
    expect(
      validateChangeRequest({
        ...validRequest(),
        stagedDocuments: [
          validStagedDocument({
            objectStorage: {
              ...validStagedDocument().objectStorage,
              url: 'javascript:alert(1)',
            },
          }),
        ],
      }).map(({ field }) => field),
    ).toContain('documents');
  });

  it('keeps legacy File context authoritative when staged documents are absent', () => {
    expect(
      validateChangeRequest(validRequest(), { documents: [validDocument()] }),
    ).toEqual([]);
  });

  it('accepts the legacy files alias and rejects mixing uploaded files with staged documents', () => {
    expect(
      validateChangeRequest(validRequest(), { files: [validDocument()] }),
    ).toEqual([]);
    expect(
      validateChangeRequest(
        {
          ...validRequest(),
          stagedDocuments: [validStagedDocument()],
        },
        { files: [validDocument()] },
      ).map(({ field }) => field),
    ).toContain('documents');
    expect(
      validateChangeRequest(
        {
          ...validRequest(),
          stagedDocuments: [validStagedDocument()],
        },
        { documents: [validDocument()] },
      ).map(({ field }) => field),
    ).toContain('documents');
  });

  it('accepts only public HTTPS or the exact guarded attachment download path', () => {
    expect(
      isSafeChangeAttachmentUrl('https://storage.example.com/path/file.pdf'),
    ).toBe(true);
    expect(
      isSafeChangeAttachmentUrl(
        '/api/duty-schedules/change-attachments/file_Abc-123/download',
      ),
    ).toBe(true);

    for (const url of [
      'http://storage.example.com/file.pdf',
      'https://user:password@storage.example.com/file.pdf',
      'https://localhost/file.pdf',
      'https://files.internal.local/file.pdf',
      'https://127.0.0.1/file.pdf',
      'https://10.0.0.8/file.pdf',
      'https://169.254.1.1/file.pdf',
      'https://172.16.1.1/file.pdf',
      'https://192.168.1.1/file.pdf',
      '/api/duty-schedules/change-attachments/../secret/download',
      '/api/duty-schedules/change-attachments/id/download?token=unsafe',
      'not-a-url',
    ]) {
      expect(isSafeChangeAttachmentUrl(url)).toBe(false);
    }
  });

  it('accepts the guarded relative download URL in staged metadata', () => {
    expect(
      validateChangeRequest({
        ...validRequest(),
        stagedDocuments: [
          validStagedDocument({
            objectStorage: {
              ...validStagedDocument().objectStorage,
              url: '/api/duty-schedules/change-attachments/safe_ID-1/download',
            },
          }),
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    ['方案.pdf', 'application/pdf'],
    ['方案.doc', 'application/msword'],
    [
      '方案.docx',
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
  ])('accepts the allowed document format %s', (name, type) => {
    expect(
      errorFields(validRequest(), [validDocument({ name, type })]),
    ).not.toContain('documents');
  });

  it('rejects unsupported or mismatched document formats', () => {
    expect(
      errorFields(validRequest(), [
        validDocument({ name: '脚本.exe', type: 'application/octet-stream' }),
      ]),
    ).toContain('documents');
    expect(
      errorFields(validRequest(), [
        validDocument({ name: '伪装.pdf', type: 'application/x-msdownload' }),
      ]),
    ).toContain('documents');
    expect(
      errorFields(validRequest(), [
        validDocument({ name: '伪装.exe', type: 'application/pdf' }),
      ]),
    ).toContain('documents');
  });
});
