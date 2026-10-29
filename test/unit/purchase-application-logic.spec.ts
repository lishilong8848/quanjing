import type {
  ProcurementForm,
  PurchaseApplicationBatchRequest,
  PurchaseApplicationValidationIssue,
} from '../../shared/purchase-application.interface';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import {
  applyProcurementFormSelection,
  buildPurchaseApplicationSubmissionFingerprint,
  buildPurchaseApplicationRetryDraft,
  calculateDraftTotals,
  changePurchaseChannel,
  changeProcurementForm,
  clearPurchaseApplicationSubmissionJournal,
  clearDraft,
  createBlankDraft,
  duplicateItem,
  groupValidationIssues,
  getPurchaseApplicationDraftKey,
  getPurchaseApplicationSubmissionJournalKey,
  isUncertainPurchaseSubmissionError,
  reconnectPurchaseApplicationAcceptance,
  loadPurchaseApplicationSubmissionJournal,
  loadDraft,
  matchesPurchaseApplicationAttachmentManifest,
  normalizePurchaseQuantityInput,
  removeItem,
  savePurchaseApplicationSubmissionJournal,
  saveDraft,
  selectPurchaseComparisonFiles,
  scopePurchaseApplicationDraft,
  validatePurchaseApplicationForUi,
  type PurchaseApplicationSubmissionJournal,
} from '../../client/src/pages/PurchaseInventoryManagement/purchase-application.logic';

const admin: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const applicantA: AccessPrincipal = {
  role: 'purchase_applicant',
  purchaseBuilding: 'A楼',
};
const applicantB: AccessPrincipal = {
  role: 'purchase_applicant',
  purchaseBuilding: 'B楼',
};

describe('purchase application draft logic', () => {
  it('reconnects a lost acceptance with the original identity and a bounded attempt count', async () => {
    const accepted = {
      pending: true as const,
      taskId: 'purchase-application-original',
      message: '已找回原采购申请任务',
    };
    const reconnect = jest
      .fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(accepted);

    await expect(
      reconnectPurchaseApplicationAcceptance({
        reconnect,
        delaysMs: [0, 0, 0],
        wait: async () => undefined,
      }),
    ).resolves.toEqual({ kind: 'accepted', accepted });
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it('stops acceptance reconnect after the configured attempts and preserves uncertainty', async () => {
    const reconnect = jest.fn().mockRejectedValue(new Error('network down'));

    await expect(
      reconnectPurchaseApplicationAcceptance({
        reconnect,
        delaysMs: [0, 0, 0],
        wait: async () => undefined,
      }),
    ).resolves.toEqual({
      kind: 'uncertain',
      message: 'network down',
    });
    expect(reconnect).toHaveBeenCalledTimes(3);
  });

  it('restores only when acceptance explicitly proves that nothing was written', async () => {
    const reconnect = jest.fn().mockRejectedValue(
      Object.assign(new Error('申请内容未受理'), {
        response: {
          data: {
            definitelyNotWritten: true,
            message: '申请内容未受理',
          },
        },
      }),
    );

    await expect(
      reconnectPurchaseApplicationAcceptance({
        reconnect,
        delaysMs: [0, 0, 0],
        wait: async () => undefined,
      }),
    ).resolves.toEqual({
      kind: 'definitely-not-written',
      message: '申请内容未受理',
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a deterministic rejection without proof of no write', async () => {
    const reconnect = jest.fn().mockRejectedValue({
      response: {
        status: 409,
        data: { message: '原编号与提交内容冲突' },
      },
    });

    await expect(
      reconnectPurchaseApplicationAcceptance({
        reconnect,
        delaysMs: [0, 0, 0],
        wait: async () => undefined,
      }),
    ).resolves.toEqual({
      kind: 'uncertain',
      message: '原编号与提交内容冲突',
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('builds the canonical attachment-aware SHA-256 fingerprint contract', async () => {
    const request = {
      shared: { supplier: 'vendor', building: 'H' },
      items: [{ quantity: 2, lineId: 'line-1' }],
    } as unknown as PurchaseApplicationBatchRequest;

    const result = await buildPurchaseApplicationSubmissionFingerprint(
      request,
      [binaryFile('quote.pdf', 'application/pdf', 'quote')],
    );

    expect(result).toEqual({
      fingerprint:
        'f4ec24611a4bc60758851dea3d4a079b9fd6f1558e95532bc79a062d3b9d01ea',
      attachments: [
        {
          name: 'quote.pdf',
          type: 'application/pdf',
          size: 5,
          sha256:
            '6327245c3a45d3d9ea72b70fbb671926e7b80f63d311bfd73dde876d5df02b26',
        },
      ],
    });
  });

  it('uses the byte-exact crypto-js fallback when WebCrypto is unavailable', async () => {
    const request = {
      shared: { supplier: 'vendor', building: 'H' },
      items: [{ quantity: 2, lineId: 'line-1' }],
    } as unknown as PurchaseApplicationBatchRequest;

    const result = await withGlobalCrypto(undefined, () =>
      buildPurchaseApplicationSubmissionFingerprint(request, [
        binaryFile('quote.pdf', 'application/pdf', 'quote'),
      ]),
    );

    expect(result).toEqual({
      fingerprint:
        'f4ec24611a4bc60758851dea3d4a079b9fd6f1558e95532bc79a062d3b9d01ea',
      attachments: [
        {
          name: 'quote.pdf',
          type: 'application/pdf',
          size: 5,
          sha256:
            '6327245c3a45d3d9ea72b70fbb671926e7b80f63d311bfd73dde876d5df02b26',
        },
      ],
    });
  });

  it('fails closed when an available WebCrypto digest rejects', async () => {
    const request = {
      shared: { supplier: 'vendor', building: 'H' },
      items: [{ quantity: 2, lineId: 'line-1' }],
    } as unknown as PurchaseApplicationBatchRequest;
    const digest = jest.fn().mockRejectedValue(new Error('digest rejected'));

    await expect(
      withGlobalCrypto({ subtle: { digest } } as unknown as Crypto, () =>
        buildPurchaseApplicationSubmissionFingerprint(request, [
          binaryFile('quote.pdf', 'application/pdf', 'quote'),
        ]),
      ),
    ).rejects.toThrow('digest rejected');
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('keeps object key order irrelevant while preserving attachment order and bytes', async () => {
    const requestA = {
      shared: { supplier: 'vendor', building: 'H' },
      items: [{ quantity: 2, lineId: 'line-1' }],
    } as unknown as PurchaseApplicationBatchRequest;
    const requestB = {
      items: [{ lineId: 'line-1', quantity: 2 }],
      shared: { building: 'H', supplier: 'vendor' },
    } as unknown as PurchaseApplicationBatchRequest;
    const first = binaryFile('first.pdf', 'application/pdf', 'first');
    const second = binaryFile('second.pdf', 'application/pdf', 'second');

    const orderedA = await buildPurchaseApplicationSubmissionFingerprint(
      requestA,
      [first, second],
    );
    const orderedB = await buildPurchaseApplicationSubmissionFingerprint(
      requestB,
      [first, second],
    );
    const reversed = await buildPurchaseApplicationSubmissionFingerprint(
      requestA,
      [second, first],
    );
    const changedBytes = await buildPurchaseApplicationSubmissionFingerprint(
      requestA,
      [binaryFile('first.pdf', 'application/pdf', 'changed'), second],
    );

    expect(orderedA.fingerprint).toBe(orderedB.fingerprint);
    expect(reversed.fingerprint).not.toBe(orderedA.fingerprint);
    expect(changedBytes.fingerprint).not.toBe(orderedA.fingerprint);
  });

  it('requires every original attachment metadata entry before a recovered POST', () => {
    const manifest = [
      {
        name: 'first.pdf',
        type: 'application/pdf',
        size: 5,
        sha256: 'a'.repeat(64),
      },
      {
        name: 'second.png',
        type: 'image/png',
        size: 6,
        sha256: 'b'.repeat(64),
      },
    ];
    const files = [
      { name: 'first.pdf', type: 'application/pdf', size: 5 },
      { name: 'second.png', type: 'image/png', size: 6 },
    ];

    expect(matchesPurchaseApplicationAttachmentManifest(files, manifest)).toBe(
      true,
    );
    expect(matchesPurchaseApplicationAttachmentManifest([], manifest)).toBe(
      false,
    );
    expect(
      matchesPurchaseApplicationAttachmentManifest(
        [...files].reverse(),
        manifest,
      ),
    ).toBe(false);
    expect(
      matchesPurchaseApplicationAttachmentManifest(
        [{ ...files[0], size: 7 }, files[1]],
        manifest,
      ),
    ).toBe(false);
    expect(matchesPurchaseApplicationAttachmentManifest([], [])).toBe(true);
  });

  it('persists an in-flight submission journal by the real signed-in principal', () => {
    const storage = memoryStorage();
    const firstAdmin = {
      ...admin,
      principalFingerprint: 'session-admin-a',
    };
    const secondAdmin = {
      ...admin,
      principalFingerprint: 'session-admin-b',
    };
    const journal: PurchaseApplicationSubmissionJournal = {
      version: 1,
      mutationId: 'mutation-12345678',
      fingerprint:
        'f4ec24611a4bc60758851dea3d4a079b9fd6f1558e95532bc79a062d3b9d01ea',
      request: makeValidDraft(),
      attachments: [
        {
          name: 'quote.pdf',
          type: 'application/pdf',
          size: 5,
          sha256:
            '6327245c3a45d3d9ea72b70fbb671926e7b80f63d311bfd73dde876d5df02b26',
        },
      ],
      status: 'submitting',
      taskId: null,
      createdAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:00:00.000Z',
    };

    savePurchaseApplicationSubmissionJournal(journal, firstAdmin, storage);

    expect(getPurchaseApplicationSubmissionJournalKey(firstAdmin)).not.toBe(
      getPurchaseApplicationSubmissionJournalKey(secondAdmin),
    );
    expect(
      loadPurchaseApplicationSubmissionJournal(firstAdmin, storage),
    ).toEqual(journal);
    expect(
      loadPurchaseApplicationSubmissionJournal(secondAdmin, storage),
    ).toBeNull();

    clearPurchaseApplicationSubmissionJournal(firstAdmin, storage);
    expect(
      loadPurchaseApplicationSubmissionJournal(firstAdmin, storage),
    ).toBeNull();
  });

  it('fails closed on malformed or cross-building submission journals', () => {
    const storage = memoryStorage();
    const principal = {
      ...applicantA,
      principalFingerprint: 'session-applicant-a',
    };
    const journal: PurchaseApplicationSubmissionJournal = {
      version: 1,
      mutationId: 'mutation-12345678',
      fingerprint: 'not-a-sha256',
      request: makeValidDraft(),
      attachments: [],
      status: 'uncertain',
      taskId: null,
      createdAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:00:00.000Z',
    };
    storage.setItem(
      getPurchaseApplicationSubmissionJournalKey(principal),
      JSON.stringify(journal),
    );

    expect(
      loadPurchaseApplicationSubmissionJournal(principal, storage),
    ).toBeNull();

    storage.setItem(
      getPurchaseApplicationSubmissionJournalKey(principal),
      JSON.stringify({
        ...journal,
        fingerprint: 'a'.repeat(64),
        request: {
          ...journal.request,
          shared: { ...journal.request.shared, building: 'B楼' },
        },
      }),
    );
    expect(
      loadPurchaseApplicationSubmissionJournal(principal, storage),
    ).toBeNull();
  });

  it('distinguishes uncertain transport failures from definite validation failures', () => {
    expect(isUncertainPurchaseSubmissionError(new Error('network down'))).toBe(
      true,
    );
    expect(
      isUncertainPurchaseSubmissionError({ response: { status: 503 } }),
    ).toBe(true);
    expect(
      isUncertainPurchaseSubmissionError({ response: { status: 408 } }),
    ).toBe(true);
    expect(
      isUncertainPurchaseSubmissionError({ response: { status: 400 } }),
    ).toBe(false);
    expect(
      isUncertainPurchaseSubmissionError({ response: { status: 409 } }),
    ).toBe(false);
  });

  it('creates a blank draft with one editable item', () => {
    const draft = createBlankDraft();

    expect(draft.shared).toEqual(
      expect.objectContaining({
        procurementForm: '三方比价',
        comparisonSatisfied: '是',
        singleReason: '',
      }),
    );
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toEqual(
      expect.objectContaining({
        mode: 'existing',
        quantity: 1,
        unitPrice: 0,
        onlineUrls: [''],
      }),
    );
    expect(draft.items[0].lineId).toBeTruthy();
  });

  it('never lets a purchase quantity input settle at zero or below', () => {
    expect(normalizePurchaseQuantityInput('')).toBe(1);
    expect(normalizePurchaseQuantityInput('0')).toBe(1);
    expect(normalizePurchaseQuantityInput('-3')).toBe(1);
    expect(normalizePurchaseQuantityInput('8')).toBe(8);
  });

  it('duplicates after the source row and never removes the last row', () => {
    const draft = createBlankDraft();
    draft.items[0].itemName = 'A4纸';
    const duplicated = duplicateItem(draft.items, draft.items[0].lineId);

    expect(duplicated).toHaveLength(2);
    expect(duplicated[1].itemName).toBe('A4纸');
    expect(duplicated[1].lineId).not.toBe(duplicated[0].lineId);
    expect(duplicated[1].onlineUrls).not.toBe(duplicated[0].onlineUrls);
    expect(removeItem([duplicated[0]], duplicated[0].lineId)).toHaveLength(1);
    expect(removeItem(duplicated, duplicated[0].lineId)).toEqual([
      duplicated[1],
    ]);
  });

  it('calculates goods, shipping, discount, and payable totals', () => {
    const draft = createBlankDraft();
    draft.items[0] = {
      ...draft.items[0],
      quantity: 2,
      unitPrice: 25.5,
      shippingFee: 5,
      discount: 1,
    };
    const duplicated = duplicateItem(draft.items, draft.items[0].lineId);
    duplicated[1] = {
      ...duplicated[1],
      quantity: 1,
      unitPrice: 120,
      shippingFee: 0,
      discount: 0,
    };

    expect(calculateDraftTotals(duplicated)).toEqual({
      itemKinds: 2,
      quantity: 3,
      goodsAmount: 171,
      shippingFee: 5,
      discount: 1,
      total: 175,
    });
  });

  it('serializes only JSON draft data and restores it from storage', () => {
    const storage = memoryStorage();
    const draft = createBlankDraft();
    draft.shared.supplier = '南通供应商';

    saveDraft(draft, admin, storage);

    expect(storage.getItem(getPurchaseApplicationDraftKey(admin))).toContain(
      '南通供应商',
    );
    expect(
      storage.getItem(getPurchaseApplicationDraftKey(admin)),
    ).not.toContain('comparisonAttachments');
    expect(loadDraft(admin, storage)).toEqual(draft);
    clearDraft(admin, storage);
    expect(loadDraft(admin, storage)).toBeNull();
  });

  it('normalizes every malformed persisted item without making the draft unreadable', () => {
    const storage = memoryStorage();
    const persistedDraft = JSON.parse(JSON.stringify(createBlankDraft()));
    persistedDraft.shared.purchaseChannel = '线上';
    persistedDraft.items = [
      {
        lineId: null,
        mode: 'custom',
        catalogRecordId: 123,
        sku: 'SKU-001',
        primaryCategory: 'A类',
        secondaryCategory: null,
        itemName: { text: '损坏名称' },
        specification: '  保留原规格  ',
        brand: false,
        quantity: '2',
        unit: 42,
        unitPrice: '12.5',
        shippingFee: 'not-a-number',
        discount: null,
        onlineUrls: ['https://example.com/item', 99, ''],
      },
      {
        lineId: '   ',
        mode: 'unknown',
        catalogRecordId: null,
        sku: null,
        primaryCategory: null,
        secondaryCategory: null,
        itemName: null,
        specification: null,
        brand: null,
        quantity: 'Infinity',
        unit: null,
        unitPrice: {},
        shippingFee: [],
        discount: '4.5',
        onlineUrls: 'https://example.com/legacy-item',
      },
    ];
    storage.setItem(
      getPurchaseApplicationDraftKey(admin),
      JSON.stringify(persistedDraft),
    );

    const restored = loadDraft(admin, storage);

    expect(restored).not.toBeNull();
    expect(restored?.items).toHaveLength(2);
    expect(restored?.items[0]).toEqual({
      lineId: expect.any(String),
      mode: 'new',
      catalogRecordId: '',
      sku: 'SKU-001',
      primaryCategory: 'A类',
      secondaryCategory: '',
      itemName: '',
      specification: '  保留原规格  ',
      brand: '',
      quantity: 2,
      unit: '',
      unitPrice: 12.5,
      shippingFee: 0,
      discount: 0,
      onlineUrls: ['https://example.com/item', ''],
    });
    expect(restored?.items[1]).toEqual({
      lineId: expect.any(String),
      mode: 'existing',
      catalogRecordId: '',
      sku: '',
      primaryCategory: '',
      secondaryCategory: '',
      itemName: '',
      specification: '',
      brand: '',
      quantity: 1,
      unit: '',
      unitPrice: 0,
      shippingFee: 0,
      discount: 4.5,
      onlineUrls: ['https://example.com/legacy-item'],
    });
    restored?.items.forEach((item) => {
      expect(item.lineId.trim()).not.toBe('');
      expect(
        [
          item.catalogRecordId,
          item.sku,
          item.primaryCategory,
          item.secondaryCategory,
          item.itemName,
          item.specification,
          item.brand,
          item.unit,
          ...(item.onlineUrls || []),
        ].every((value) => typeof value === 'string'),
      ).toBe(true);
      expect(
        [item.quantity, item.unitPrice, item.shippingFee, item.discount].every(
          Number.isFinite,
        ),
      ).toBe(true);
    });
    expect(() => validatePurchaseApplicationForUi(restored!, [])).not.toThrow();
  });

  it('switches to single procurement without clearing its reason or changing other fields', () => {
    const shared = {
      ...createBlankDraft().shared,
      purchaseMethod: '需求自采（楼内）' as const,
      purchaseChannel: '线上' as const,
      onlineUrl: 'https://example.com/item',
      singleReason: '原厂备件只能从原厂采购',
    };

    expect(changeProcurementForm(shared, '单一采购')).toEqual({
      ...shared,
      procurementForm: '单一采购',
      comparisonSatisfied: '否',
    });
  });

  it('switches back to comparison procurement and clears the single-source reason', () => {
    const shared = {
      ...createBlankDraft().shared,
      procurementForm: '单一采购' as const,
      comparisonSatisfied: '否' as const,
      singleReason: '原厂备件只能从原厂采购',
      purchaseMethod: '需求自采（楼内）' as const,
      purchaseChannel: '线上' as const,
    };

    expect(changeProcurementForm(shared, '三方比价')).toEqual({
      ...shared,
      procurementForm: '三方比价',
      comparisonSatisfied: '是',
      singleReason: '',
    });
  });

  it.each(['线下', '线上'] as const)('requires three comparison images for %s procurement', (channel) => {
    for (const count of [0, 1, 2]) {
      const issues = validatePurchaseApplicationForUi(makeValidDraft('三方比价', channel), comparisonImages(count));
      expect(issues).toContainEqual(expect.objectContaining({
        code: 'REQUIRED_COMPARISON_ATTACHMENT',
        path: 'shared.comparisonAttachment',
        message: expect.stringContaining('3'),
      }));
    }
  });

  it.each(['线下', '线上'] as const)('accepts three required images with up to two optional attachments for %s procurement', (channel) => {
    const draft = makeValidDraft('三方比价', channel);
    for (const optional of [[], [{ type: 'application/pdf' }], [{ type: 'application/pdf' }, { type: 'application/pdf' }]]) {
      expect(validatePurchaseApplicationForUi(draft, [...comparisonImages(3), ...optional])).toEqual([]);
    }
    expect(validatePurchaseApplicationForUi(draft, comparisonImages(4))).toEqual([]);
    expect(validatePurchaseApplicationForUi(draft, comparisonImages(5))).toEqual([]);
  });

  it('does not count PDFs toward the three images and rejects more than five total attachments', () => {
    const draft = makeValidDraft();
    for (const files of [
      [...comparisonImages(2), ...Array.from({ length: 3 }, () => ({ type: 'application/pdf' }))],
      comparisonImages(6),
    ]) {
      expect(validatePurchaseApplicationForUi(draft, files)).toContainEqual(expect.objectContaining({ path: 'shared.comparisonAttachment' }));
    }
  });

  it('requires another image after removing one of the three required images', () => {
    const draft = makeValidDraft();
    const files = comparisonImages(3);
    expect(validatePurchaseApplicationForUi(draft, files)).toEqual([]);
    expect(validatePurchaseApplicationForUi(draft, files.slice(1))).toContainEqual(expect.objectContaining({ path: 'shared.comparisonAttachment' }));
    expect(files).toHaveLength(3);
  });

  it('keeps original attachments recoverable without applying a new policy, while retaining other required fields', () => {
    const draft = makeValidDraft();
    const originalFiles = [{ type: 'application/pdf' }];
    expect(validatePurchaseApplicationForUi(draft, originalFiles)).toContainEqual(expect.objectContaining({ path: 'shared.comparisonAttachment' }));
    expect(validatePurchaseApplicationForUi(draft, originalFiles, { recoveringSubmission: true })).toEqual([]);
    draft.shared.supplier = '';
    expect(validatePurchaseApplicationForUi(draft, originalFiles, { recoveringSubmission: true })).toContainEqual(expect.objectContaining({ path: 'shared.supplier' }));
    expect(originalFiles).toEqual([{ type: 'application/pdf' }]);
  });

  it('requires a reason instead of an attachment for offline single procurement', () => {
    const draft = makeValidDraft('单一采购', '线下');
    draft.shared.singleReason = '   ';

    const issues = validatePurchaseApplicationForUi(draft, []);

    expect(issues).toContainEqual({
      code: 'REQUIRED',
      path: 'shared.singleReason',
      message: '请填写单一采购原因',
    });
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'shared.comparisonAttachment',
        }),
      ]),
    );
  });

  it('accepts a trimmed single procurement reason without an attachment', () => {
    const draft = makeValidDraft('单一采购', '线下');
    draft.shared.singleReason = '  原厂备件只能从原厂采购  ';
    draft.shared.comparisonSatisfied =
      '' as PurchaseApplicationBatchRequest['shared']['comparisonSatisfied'];

    expect(validatePurchaseApplicationForUi(draft, [])).toEqual([]);
  });

  it('rejects an unknown procurement form', () => {
    const draft = makeValidDraft();
    draft.shared.procurementForm = '未知形式' as ProcurementForm;

    expect(validatePurchaseApplicationForUi(draft, comparisonImages(1))).toContainEqual({
      code: 'REQUIRED',
      path: 'shared.procurementForm',
      message: '请选择采购形式',
    });
  });

  it('selects comparison files only for comparison procurement', () => {
    const files = [{ name: 'comparison.pdf' }];

    expect(selectPurchaseComparisonFiles('单一采购', files)).toEqual([]);
    const selected = selectPurchaseComparisonFiles('三方比价', files);
    expect(selected).toEqual(files);
    expect(selected).not.toBe(files);
  });

  it('applies procurement form selection with dependent files and errors atomically', () => {
    const files = [{ name: 'comparison.pdf' }];
    const shared = {
      ...createBlankDraft().shared,
      singleReason: '原厂备件只能从原厂采购',
    };

    const singleSelection = applyProcurementFormSelection(
      shared,
      files,
      '单一采购',
    );

    expect(singleSelection).toEqual({
      nextShared: {
        ...shared,
        procurementForm: '单一采购',
        comparisonSatisfied: '否',
      },
      nextFiles: [],
      clearedErrorFields: [
        'procurementForm',
        'singleReason',
        'comparisonAttachment',
        'comparisonSatisfied',
      ],
    });

    expect(
      applyProcurementFormSelection(
        singleSelection.nextShared,
        singleSelection.nextFiles,
        '三方比价',
      ),
    ).toEqual({
      nextShared: {
        ...singleSelection.nextShared,
        procurementForm: '三方比价',
        comparisonSatisfied: '是',
        singleReason: '',
      },
      nextFiles: [],
      clearedErrorFields: singleSelection.clearedErrorFields,
    });
  });

  it('keeps the full submission draft when no failed line IDs are returned', () => {
    const submissionDraft = draftWithTwoItems();

    expect(buildPurchaseApplicationRetryDraft(submissionDraft, [])).toBe(
      submissionDraft,
    );
  });

  it('keeps the full submission draft when failed line IDs do not match', () => {
    const submissionDraft = draftWithTwoItems();

    expect(
      buildPurchaseApplicationRetryDraft(submissionDraft, ['', 'unknown-line']),
    ).toBe(submissionDraft);
  });

  it('keeps only the original items matching known failed line IDs', () => {
    const submissionDraft = draftWithTwoItems();

    const retryDraft = buildPurchaseApplicationRetryDraft(submissionDraft, [
      'line-2',
    ]);

    expect(retryDraft).not.toBe(submissionDraft);
    expect(retryDraft.items).toEqual([submissionDraft.items[1]]);
    expect(submissionDraft.items).toHaveLength(2);
  });

  it('migrates a legacy negative comparison draft to single procurement', () => {
    const storage = memoryStorage();
    const legacyDraft = JSON.parse(JSON.stringify(createBlankDraft()));
    delete legacyDraft.shared.procurementForm;
    delete legacyDraft.shared.singleReason;
    legacyDraft.shared.comparisonSatisfied = '否';
    storage.setItem(
      getPurchaseApplicationDraftKey(admin),
      JSON.stringify(legacyDraft),
    );

    expect(loadDraft(admin, storage)?.shared).toEqual(
      expect.objectContaining({
        procurementForm: '单一采购',
        comparisonSatisfied: '否',
        singleReason: '',
      }),
    );
  });

  it('migrates a legacy affirmative comparison draft to comparison procurement', () => {
    const storage = memoryStorage();
    const legacyDraft = JSON.parse(JSON.stringify(createBlankDraft()));
    delete legacyDraft.shared.procurementForm;
    delete legacyDraft.shared.singleReason;
    legacyDraft.shared.comparisonSatisfied = '是';
    storage.setItem(
      getPurchaseApplicationDraftKey(admin),
      JSON.stringify(legacyDraft),
    );

    expect(loadDraft(admin, storage)?.shared).toEqual(
      expect.objectContaining({
        procurementForm: '三方比价',
        comparisonSatisfied: '是',
        singleReason: '',
      }),
    );
  });

  it('uses comparison procurement when a legacy comparison value is missing', () => {
    const storage = memoryStorage();
    const legacyDraft = JSON.parse(JSON.stringify(createBlankDraft()));
    delete legacyDraft.shared.procurementForm;
    delete legacyDraft.shared.comparisonSatisfied;
    delete legacyDraft.shared.singleReason;
    storage.setItem(
      getPurchaseApplicationDraftKey(admin),
      JSON.stringify(legacyDraft),
    );

    expect(loadDraft(admin, storage)?.shared).toEqual(
      expect.objectContaining({
        procurementForm: '三方比价',
        comparisonSatisfied: '是',
        singleReason: '',
      }),
    );
  });

  it('prefers a valid new procurement form and normalizes its compatibility field', () => {
    const storage = memoryStorage();
    const draft = createBlankDraft();
    draft.shared.procurementForm = '单一采购';
    draft.shared.comparisonSatisfied = '是';
    draft.shared.singleReason = '原厂备件只能从原厂采购';
    storage.setItem(
      getPurchaseApplicationDraftKey(admin),
      JSON.stringify(draft),
    );

    expect(loadDraft(admin, storage)?.shared).toEqual(
      expect.objectContaining({
        procurementForm: '单一采购',
        comparisonSatisfied: '否',
        singleReason: '原厂备件只能从原厂采购',
      }),
    );

    draft.shared.procurementForm = '三方比价';
    draft.shared.comparisonSatisfied = '否';
    storage.setItem(
      getPurchaseApplicationDraftKey(admin),
      JSON.stringify(draft),
    );

    expect(loadDraft(admin, storage)?.shared).toEqual(
      expect.objectContaining({
        procurementForm: '三方比价',
        comparisonSatisfied: '是',
        singleReason: '',
      }),
    );
  });

  it('falls back safely when a persisted procurement form is unknown', () => {
    const storage = memoryStorage();
    const draft = JSON.parse(JSON.stringify(createBlankDraft()));
    draft.shared.procurementForm = '任意采购形式';
    draft.shared.comparisonSatisfied = '否';
    storage.setItem(
      getPurchaseApplicationDraftKey(admin),
      JSON.stringify(draft),
    );

    expect(loadDraft(admin, storage)?.shared).toEqual(
      expect.objectContaining({
        procurementForm: '三方比价',
        comparisonSatisfied: '是',
      }),
    );
  });

  it('partitions drafts by role and applicant building', () => {
    const storage = memoryStorage();
    const draftA = scopePurchaseApplicationDraft(
      applicantA,
      createBlankDraft(),
    );
    draftA.shared.supplier = 'A楼供应商';
    const draftB = scopePurchaseApplicationDraft(
      applicantB,
      createBlankDraft(),
    );
    draftB.shared.supplier = 'B楼供应商';

    saveDraft(draftA, applicantA, storage);
    saveDraft(draftB, applicantB, storage);

    expect(getPurchaseApplicationDraftKey(applicantA)).not.toBe(
      getPurchaseApplicationDraftKey(applicantB),
    );
    expect(loadDraft(applicantA, storage)?.shared.supplier).toBe('A楼供应商');
    expect(loadDraft(applicantB, storage)?.shared.supplier).toBe('B楼供应商');
  });

  it('forces the applicant session building without mutating the source draft', () => {
    const draft = createBlankDraft();
    draft.shared.building = 'B楼';

    const scoped = scopePurchaseApplicationDraft(applicantA, draft);

    expect(scoped.shared.building).toBe('A楼');
    expect(draft.shared.building).toBe('B楼');
    expect(scopePurchaseApplicationDraft(admin, draft)).toEqual(draft);
  });

  it('does not restore the legacy global draft or a cross-building scoped draft for an applicant', () => {
    const storage = memoryStorage();
    const crossBuilding = createBlankDraft();
    crossBuilding.shared.building = 'B楼';
    storage.setItem(
      'purchase-inventory.application-draft.v1',
      JSON.stringify(crossBuilding),
    );

    expect(loadDraft(applicantA, storage)).toBeNull();

    storage.setItem(
      getPurchaseApplicationDraftKey(applicantA),
      JSON.stringify(crossBuilding),
    );
    expect(loadDraft(applicantA, storage)).toBeNull();
  });

  it('groups shared and item errors without losing line IDs', () => {
    const issues: PurchaseApplicationValidationIssue[] = [
      { code: 'REQUIRED', path: 'shared.supplier', message: '请填写供应商' },
      {
        code: 'INVALID_QUANTITY',
        path: 'quantity',
        lineId: 'line-2',
        message: '采购数量必须为正整数',
      },
      { code: 'EMPTY_ITEMS', path: 'items', message: '至少添加一种物品' },
    ];

    expect(groupValidationIssues(issues)).toEqual({
      shared: { supplier: '请填写供应商' },
      items: { 'line-2': { quantity: '采购数量必须为正整数' } },
      general: ['至少添加一种物品'],
    });
  });

  it('clears a stale online link when switching to offline purchase', () => {
    const shared = createBlankDraft().shared;
    shared.purchaseChannel = '线上';
    shared.onlineUrl = 'https://example.com/item';

    expect(changePurchaseChannel(shared, '线下')).toEqual({
      ...shared,
      purchaseChannel: '线下',
      onlineUrl: '',
    });
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

function binaryFile(name: string, type: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    type,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
  };
}

async function withGlobalCrypto<T>(
  crypto: Crypto | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: crypto,
  });
  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    } else {
      delete (globalThis as { crypto?: Crypto }).crypto;
    }
  }
}

function draftWithTwoItems(): PurchaseApplicationBatchRequest {
  const draft = createBlankDraft();
  draft.items = [
    { ...draft.items[0], lineId: 'line-1', itemName: '物品一' },
    { ...draft.items[0], lineId: 'line-2', itemName: '物品二' },
  ];
  return draft;
}

function makeValidDraft(
  procurementForm: ProcurementForm = '三方比价',
  purchaseChannel: PurchaseApplicationBatchRequest['shared']['purchaseChannel'] = '线下',
): PurchaseApplicationBatchRequest {
  const draft = createBlankDraft();
  draft.shared = {
    ...draft.shared,
    applicantName: '测试申请人',
    supplier: '测试供应商',
    procurementForm,
    comparisonSatisfied: procurementForm === '单一采购' ? '否' : '是',
    singleReason:
      procurementForm === '单一采购' ? '原厂备件只能从原厂采购' : '',
    purchaseChannel,
    requirementSummary: '测试采购需求',
    expectedDeliveryDate: '2099-12-31',
  };
  draft.items[0] = {
    ...draft.items[0],
    catalogRecordId: 'catalog-1',
    primaryCategory: 'A类',
    secondaryCategory: 'A01',
    itemName: '测试物品',
    unit: '件',
    unitPrice: 10,
    onlineUrls:
      purchaseChannel === '线上' ? ['https://example.com/item'] : [''],
  };
  return draft;
}

function comparisonImages(count: number) {
  const types = ['image/jpeg', 'image/png', 'image/webp'];
  return Array.from({ length: count }, (_, index) => ({ type: types[index % types.length] }));
}
