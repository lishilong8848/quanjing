import type { ChangeInfo } from '../../../shared/api.interface';
import {
  CHANGE_ADJUSTMENT_RECORD_FIELDS,
  ChangeAdjustmentRecordMappingError,
  applyChangeAdjustmentSnapshotToChangeInfo,
  buildChangeAttachmentProxyUrl,
  extendChangeInfoWithAdjustmentRecord,
  mapChangeAdjustmentRecordSnapshot,
  parseChangeAttachmentField,
} from './change-adjustment-record';

const publicRecord = (overrides: Partial<ChangeInfo> = {}): ChangeInfo => ({
  id: 'rec-change-1',
  bitableRecordId: 'rec-change-1',
  title: '旧变更标题',
  startDate: '2026-08-10T01:00:00.000Z',
  endDate: '2026-08-10T10:00:00.000Z',
  actualStartDate: null,
  actualEndDate: null,
  plannedDelayStartDate: null,
  plannedDelayEndDate: null,
  level: '二级',
  type: '计划变更',
  progress: '未开始',
  executor: '王执行',
  scheduleStatus: 'finished',
  buildings: ['H楼'],
  riskSummary: '旧风险',
  isKey: false,
  recordUrl: 'https://vnet.feishu.cn/base/example',
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  ...overrides,
});

const baseRecord = (overrides: Record<string, unknown> = {}) => ({
  record_id: 'rec-change-1',
  revision: 7,
  created_time: Date.parse('2026-08-08T00:30:00.000Z'),
  last_modified_time: Date.parse('2026-08-09T01:30:00.000Z'),
  fields: {
    fld4Mb34MM: '新变更标题',
    fldVD5BNEQ: Date.parse('2026-08-10T01:00:00.000Z'),
    fldrl38KPS: Date.parse('2026-08-10T10:00:00.000Z'),
    fldu91qLqi: Date.parse('2026-08-10T01:30:00.000Z'),
    fldnKfcbCa: null,
    fldDnCn6n4: Date.parse('2026-08-10T02:00:00.000Z'),
    fldThF1p25: Date.parse('2026-08-10T12:00:00.000Z'),
    延期理由: '上游窗口延后',
    fldQqzl4HN: [
      {
        file_token: 'boxcn_evidence_1',
        name: '延期举证.png',
        size: 1024,
        type: 'image/png',
        tmp_url: 'https://open.feishu.cn/temporary/secret',
      },
    ],
    fld0qzcXDh: [
      {
        file_token: 'boxcn_scheme_1',
        name: '方案.pdf',
        size: 4096,
        type: 'application/pdf',
        tmp_url: 'https://open.feishu.cn/temporary/secret',
        url: 'https://open.feishu.cn/temporary/also-secret',
      },
    ],
    申请提交人: [
      {
        id: 'ou_private_open_id',
        name: '马进宇',
        email: 'private@example.test',
        mobile: '13800000000',
        avatar_url: 'https://private.example.test/avatar.png',
      },
    ],
    调整请求唯一ID: 'change-adjustment-123e4567-e89b-42d3-a456-426614174000',
    调整请求指纹: 'sha256-safe-fingerprint',
    ...overrides,
  },
});

describe('change adjustment record mapper', () => {
  it('declares the real submitter, workflow and summary lookup field aliases', () => {
    const fields = CHANGE_ADJUSTMENT_RECORD_FIELDS as Record<
      string,
      readonly string[]
    >;

    expect(fields.submitter).toEqual([
      'fld9oFnegn',
      'fldmngj6bh',
      '变更提交人',
      '申请提交人',
    ]);
    expect(fields.workflowStatus).toEqual([
      'fld2MxlOnp',
      '变更提交审核流程（内部）',
    ]);
    expect(fields.summaryReport).toEqual(['flddJ80cXx', '变更总结报告']);
  });

  it.each(['fld9oFnegn', 'fldmngj6bh'])(
    'maps submitter through real field ID %s',
    async (fieldId) => {
      const extended = await extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({
          [fieldId]: [{ name: `提交人-${fieldId}` }],
        }),
      );

      expect(extended?.submitterName).toBe(`提交人-${fieldId}`);
    },
  );

  it.each([
    ['审批通过', '审批通过'],
    [20260811, '20260811'],
    [['审批', '通过'], '审批、通过'],
    [{ text: '流程完成' }, '流程完成'],
    [{ name: '流程退回' }, '流程退回'],
    [{ value: [{ text: '审批' }, 2] }, '审批、2'],
  ])(
    'maps safe workflow value %# to public ChangeInfo',
    async (value, expected) => {
      const extended = await extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ fld2MxlOnp: value }),
      );

      expect(extended?.workflowStatus).toBe(expected);
    },
  );

  it.each([
    null,
    undefined,
    '',
    [],
    { raw_value: [] },
    { value: [] },
    { link_value: [] },
    { items: [] },
    { type: 'attachment', raw_value: [] },
    { type: 'attachment', name: 'summary.pdf', raw_value: [] },
    {
      type: 'lookup',
      raw_value: [{ type: 'attachment', name: 'summary.pdf' }],
    },
  ])(
    'maps empty or metadata-only summary lookup value %# to false',
    async (value) => {
      const extended = await extendChangeInfoWithAdjustmentRecord(
        publicRecord({ hasSummaryReport: true }),
        baseRecord({ flddJ80cXx: value }),
      );

      expect(extended?.hasSummaryReport).toBe(false);
    },
  );

  it.each([
    ['boxcn_summary_direct'],
    [['boxcn_summary_array']],
    [[{ file_token: 'boxcn_summary_direct' }]],
    [{ raw_value: [{ file_token: 'boxcn_summary_lookup' }] }],
    [
      {
        value: {
          link_value: { items: [{ token: 'boxcn_summary_nested' }] },
        },
      },
    ],
  ])('maps present summary lookup value %# to true', async (value) => {
    const extended = await extendChangeInfoWithAdjustmentRecord(
      publicRecord(),
      baseRecord({ flddJ80cXx: value }),
    );

    expect(extended?.hasSummaryReport).toBe(true);
  });

  it('does not expose summary attachment tokens or URLs in ChangeInfo', async () => {
    const extended = await extendChangeInfoWithAdjustmentRecord(
      publicRecord(),
      baseRecord({
        flddJ80cXx: [
          {
            attachmentToken: 'boxcn_private_summary',
            extra: 'safe lookup metadata',
            id: 'summary-attachment-id',
            mimeType: 'application/pdf',
            name: 'summary.pdf',
            size: 4096,
            timeStamp: 1786424400000,
          },
        ],
      }),
    );

    expect(extended?.hasSummaryReport).toBe(true);
    expect(JSON.stringify(extended)).not.toContain('boxcn_private_summary');
    expect(JSON.stringify(extended)).not.toContain('safe lookup metadata');
  });

  it('fails closed for unsafe workflow values', async () => {
    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ fld2MxlOnp: { status: '审批通过' } }),
      ),
    ).rejects.toThrow(ChangeAdjustmentRecordMappingError);
    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ fld2MxlOnp: '审批\n通过' }),
      ),
    ).rejects.toThrow('变更提交审核流程（内部）格式无效');
  });

  it('fails closed with a mapping error for deeply nested workflow and submitter values', async () => {
    let workflowValue: unknown = '审批通过';
    let submitterValue: unknown = { name: '马进宇' };
    for (let depth = 0; depth < 20_000; depth += 1) {
      workflowValue = [workflowValue];
      submitterValue = [submitterValue];
    }

    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ fld2MxlOnp: workflowValue }),
      ),
    ).rejects.toBeInstanceOf(ChangeAdjustmentRecordMappingError);
    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ fld9oFnegn: submitterValue }),
      ),
    ).rejects.toBeInstanceOf(ChangeAdjustmentRecordMappingError);
  });

  it.each([
    42,
    true,
    '总结报告已提交',
    'https://open.feishu.cn/temporary/not-a-token',
    'file_token',
    'tok_metadata',
    {},
    { status: 'submitted' },
    { raw_value: [false] },
    { file_token: '' },
    { token: 'bad token' },
  ])('fails closed for invalid summary lookup value %#', async (value) => {
    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ flddJ80cXx: value }),
      ),
    ).rejects.toThrow(ChangeAdjustmentRecordMappingError);
  });

  it('fails closed for cyclic, control-character and exceptional summary objects', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.raw_value = cyclic;
    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ flddJ80cXx: cyclic }),
      ),
    ).rejects.toThrow(ChangeAdjustmentRecordMappingError);
    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ flddJ80cXx: { value: '已提交\u0000异常' } }),
      ),
    ).rejects.toThrow('变更总结报告格式无效');

    const getter = jest.fn(() => [{ file_token: 'boxcn_getter_summary' }]);
    const exceptional: Record<string, unknown> = {};
    Object.defineProperty(exceptional, 'raw_value', {
      enumerable: true,
      get: getter,
    });
    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ flddJ80cXx: exceptional }),
      ),
    ).rejects.toThrow(ChangeAdjustmentRecordMappingError);
    expect(getter).not.toHaveBeenCalled();
  });

  it('fails closed with a mapping error for a 20,000-level summary value', async () => {
    let value: unknown = { file_token: 'boxcn_deep_summary' };
    for (let depth = 0; depth < 20_000; depth += 1) {
      value = { value };
    }

    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ flddJ80cXx: value }),
      ),
    ).rejects.toBeInstanceOf(ChangeAdjustmentRecordMappingError);
  });

  it('fails closed when summary arrays, objects or total nodes exceed traversal budgets', async () => {
    const largeArray = Array.from({ length: 20_000 }, () => null);
    const broadTree = Array.from({ length: 100 }, () =>
      Array.from({ length: 50 }, () => null),
    );
    const largeObject: Record<string, unknown> = { raw_value: [] };
    for (let index = 0; index < 200; index += 1) {
      largeObject[`metadata_${index}`] = 'safe';
    }

    for (const value of [largeArray, broadTree, largeObject]) {
      await expect(
        extendChangeInfoWithAdjustmentRecord(
          publicRecord(),
          baseRecord({ flddJ80cXx: value }),
        ),
      ).rejects.toBeInstanceOf(ChangeAdjustmentRecordMappingError);
    }
  });

  it('fails closed for non-plain summary objects', async () => {
    class SummaryEnvelope {
      raw_value = [{ file_token: 'boxcn_prototype_summary' }];
    }

    await expect(
      extendChangeInfoWithAdjustmentRecord(
        publicRecord(),
        baseRecord({ flddJ80cXx: new SummaryEnvelope() }),
      ),
    ).rejects.toBeInstanceOf(ChangeAdjustmentRecordMappingError);
  });

  it('maps authoritative Base fields, ignores formula lifecycle and exposes only submitter name', async () => {
    const snapshot = await mapChangeAdjustmentRecordSnapshot(
      baseRecord(),
      publicRecord(),
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      recordId: 'rec-change-1',
      version: 7,
      updatedAt: '2026-08-09T01:30:00.000Z',
      plannedStartAt: '2026-08-10T01:00:00.000Z',
      plannedEndAt: '2026-08-10T10:00:00.000Z',
      actualStartAt: '2026-08-10T01:30:00.000Z',
      actualEndAt: null,
      plannedDelayStartAt: '2026-08-10T02:00:00.000Z',
      plannedDelayEndAt: '2026-08-10T12:00:00.000Z',
      reason: '上游窗口延后',
      adjustmentMutationId:
        'change-adjustment-123e4567-e89b-42d3-a456-426614174000',
      adjustmentFingerprint: 'sha256-safe-fingerprint',
    });
    expect(snapshot?.publicRecord).toMatchObject({
      title: '新变更标题',
      actualStartDate: '2026-08-10T01:30:00.000Z',
      actualEndDate: null,
      plannedDelayStartDate: '2026-08-10T02:00:00.000Z',
      plannedDelayEndDate: '2026-08-10T12:00:00.000Z',
      submitterName: '马进宇',
      scheduleStatus: null,
      delayReason: '上游窗口延后',
      updatedAt: '2026-08-09T01:30:00.000Z',
    });
    const serialized = JSON.stringify(snapshot?.publicRecord);
    expect(serialized).not.toContain('ou_private_open_id');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('13800000000');
    expect(serialized).not.toContain('avatar.png');
  });

  it('uses stable encoded same-origin proxy URLs and never Base tmp_url/url', async () => {
    const snapshot = await mapChangeAdjustmentRecordSnapshot(
      baseRecord(),
      publicRecord(),
    );
    const document = snapshot?.documents[0];
    const evidence = snapshot?.evidence?.[0];

    expect(document).toEqual({
      fileToken: 'boxcn_scheme_1',
      name: '方案.pdf',
      size: 4096,
      mimeType: 'application/pdf',
      url: '/api/duty-schedules/change-records/rec-change-1/attachments/boxcn_scheme_1',
      objectStorage: null,
    });
    expect(evidence?.url).toBe(
      '/api/duty-schedules/change-records/rec-change-1/attachments/boxcn_evidence_1',
    );
    expect(JSON.stringify(snapshot)).not.toContain('/temporary/');
    expect(buildChangeAttachmentProxyUrl('rec_%E4%B8%AD', 'box_cn token')).toBe(
      '/api/duty-schedules/change-records/rec_%25E4%25B8%25AD/attachments/box_cn%20token',
    );
  });

  it('hydrates validated object-storage metadata by token without replacing proxy URL', async () => {
    const resolver = jest.fn(async ({ fileToken }: { fileToken: string }) =>
      fileToken === 'boxcn_scheme_1'
        ? {
            id: 'storage-scheme-1',
            filePath: 'change-adjustments/rec-change-1/scheme.pdf',
            bucketId: 'change-documents',
            url: 'https://cos.example.test/signed/scheme.pdf',
          }
        : null,
    );

    const snapshot = await mapChangeAdjustmentRecordSnapshot(
      baseRecord(),
      publicRecord(),
      { resolveStorage: resolver },
    );

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(snapshot?.documents[0]).toMatchObject({
      url: '/api/duty-schedules/change-records/rec-change-1/attachments/boxcn_scheme_1',
      objectStorage: {
        id: 'storage-scheme-1',
        filePath: 'change-adjustments/rec-change-1/scheme.pdf',
        bucketId: 'change-documents',
        url: 'https://cos.example.test/signed/scheme.pdf',
      },
    });
    expect(snapshot?.evidence?.[0].objectStorage).toBeNull();
  });

  it('supports Chinese aliases and falls back to the supplied public record for missing dates', async () => {
    const record = baseRecord({
      fldVD5BNEQ: undefined,
      fldrl38KPS: undefined,
      fldu91qLqi: undefined,
      fldDnCn6n4: undefined,
      fldThF1p25: undefined,
      '计划开始日期（阿里）': '2026/08/10 09:30',
      '计划结束日期（阿里）': '2026/08/10 19:30',
      计划延迟开始日期: '2026-08-10T10:00:00+08:00',
      计划延迟结束日期: '2026-08-10T20:00:00+08:00',
    });

    const snapshot = await mapChangeAdjustmentRecordSnapshot(
      record,
      publicRecord(),
    );

    expect(snapshot?.plannedStartAt).toBe('2026-08-10T01:30:00.000Z');
    expect(snapshot?.plannedEndAt).toBe('2026-08-10T11:30:00.000Z');
    expect(snapshot?.plannedDelayStartAt).toBe('2026-08-10T02:00:00.000Z');
    expect(snapshot?.plannedDelayEndAt).toBe('2026-08-10T12:00:00.000Z');
  });

  it('returns null for a missing/invalid record identity instead of mapping another record', async () => {
    await expect(
      mapChangeAdjustmentRecordSnapshot(
        { ...baseRecord(), record_id: '' },
        publicRecord(),
      ),
    ).resolves.toBeNull();
    await expect(
      mapChangeAdjustmentRecordSnapshot(
        { ...baseRecord(), record_id: '../rec-change-1' },
        publicRecord(),
      ),
    ).rejects.toThrow(ChangeAdjustmentRecordMappingError);
  });

  it('keeps eligibility metadata when Feishu omits attachment MIME metadata', async () => {
    const extended = await extendChangeInfoWithAdjustmentRecord(
      publicRecord({ progress: '已结束' }),
      baseRecord({
        fld0qzcXDh: [
          {
            file_token: 'boxcn_scheme_without_mime',
            name: 'change-plan.xlsx',
            size: 33065,
          },
        ],
        fld9oFnegn: [{ name: '刘小杏' }],
        fld2MxlOnp: '变更成功',
        flddJ80cXx: null,
      }),
    );

    expect(extended).toMatchObject({
      submitterName: '刘小杏',
      workflowStatus: '变更成功',
      hasSummaryReport: false,
      planDocuments: [
        expect.objectContaining({
          fileToken: 'boxcn_scheme_without_mime',
          name: 'change-plan.xlsx',
          size: 33065,
          mimeType: 'application/octet-stream',
        }),
      ],
    });
  });

  it.each([
    ['not-an-array', '变更文档必须是附件数组'],
    [[{ file_token: 'boxcn_1', name: 'a.pdf', size: -1, type: 'pdf' }], '大小'],
    [[{ file_token: 'boxcn_1', name: 'a.pdf', size: 1, type: 1 }], '类型'],
    [[{ file_token: 'boxcn_1', size: 1, type: 'pdf' }], '文件名'],
    [[{ file_token: '../token', name: 'a.pdf', size: 1, type: 'pdf' }], '标识'],
    [
      [{ file_token: 'boxcn_1', name: '../a.pdf', size: 1, type: 'pdf' }],
      '文件名',
    ],
    [
      [{ file_token: 'boxcn_1\n', name: 'a.pdf', size: 1, type: 'pdf' }],
      '标识',
    ],
  ])('fails closed for malformed attachment field %#', (field, message) => {
    expect(() =>
      parseChangeAttachmentField(field, {
        fieldLabel: '变更文档',
        recordId: 'rec-change-1',
      }),
    ).toThrow(message);
  });

  it('rejects duplicate tokens instead of silently changing the attachment set', () => {
    const duplicated = [
      { file_token: 'boxcn_1', name: 'a.pdf', size: 1, type: 'pdf' },
      { file_token: 'boxcn_1', name: 'b.pdf', size: 2, type: 'pdf' },
    ];
    expect(() =>
      parseChangeAttachmentField(duplicated, {
        fieldLabel: '变更文档',
        recordId: 'rec-change-1',
      }),
    ).toThrow('附件标识重复');
  });

  it('fails closed for invalid optional dates, mutation markers and storage metadata', async () => {
    await expect(
      mapChangeAdjustmentRecordSnapshot(
        baseRecord({ fldThF1p25: 'not-a-date' }),
        publicRecord(),
      ),
    ).rejects.toThrow('计划延迟结束日期格式无效');
    await expect(
      mapChangeAdjustmentRecordSnapshot(
        baseRecord({ 调整请求指纹: 'bad\nvalue' }),
        publicRecord(),
      ),
    ).rejects.toThrow('调整请求指纹格式无效');
    await expect(
      mapChangeAdjustmentRecordSnapshot(baseRecord(), publicRecord(), {
        resolveStorage: async () => ({
          id: 'storage-1',
          filePath: '../outside/scheme.pdf',
          bucketId: 'bucket-1',
          url: 'https://cos.example.test/scheme.pdf',
        }),
      }),
    ).rejects.toThrow('对象存储路径格式无效');
  });

  it('extends annual ChangeInfo and supports converting a saved snapshot back to public data', async () => {
    const extended = await extendChangeInfoWithAdjustmentRecord(
      publicRecord(),
      baseRecord(),
    );
    expect(extended?.planDocuments?.map((item) => item.fileToken)).toEqual([
      'boxcn_scheme_1',
    ]);
    expect(extended?.delayEvidence?.map((item) => item.fileToken)).toEqual([
      'boxcn_evidence_1',
    ]);
    expect(extended?.scheduleStatus).toBeNull();
    expect(extended?.workflowStatus).toBeNull();
    expect(extended?.hasSummaryReport).toBe(false);

    const snapshot = await mapChangeAdjustmentRecordSnapshot(
      baseRecord(),
      publicRecord(),
    );
    expect(snapshot).not.toBeNull();
    const response = applyChangeAdjustmentSnapshotToChangeInfo(snapshot!, {
      scheduleStatus: 'in-progress',
    });
    expect(response).toMatchObject({
      id: 'rec-change-1',
      bitableRecordId: 'rec-change-1',
      scheduleStatus: 'in-progress',
      delayReason: '上游窗口延后',
      updatedAt: '2026-08-09T01:30:00.000Z',
    });
    expect(response.planDocuments).not.toBe(snapshot?.documents);
  });
});
