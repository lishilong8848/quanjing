import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  InventoryMovementOptionItem,
  PurchasePendingInboundItem,
} from '../../shared/inventory-management.interface';

jest.mock('lucide-react', () => ({
  CheckCircle2: () => null,
  Loader2: () => null,
  PackagePlus: () => null,
  Search: () => null,
}));
jest.mock('sonner', () => ({
  toast: { error: jest.fn() },
}));
jest.mock(
  '@/api',
  () => ({
    createWarehouseStorageLocation: jest.fn(),
    getInventoryMovementOptions: jest.fn(),
    getWarehouseStorageLocations: jest.fn(),
    preparePurchaseInboundCategory: jest.fn(),
  }),
  { virtual: true },
);
for (const moduleName of [
  '@/components/ui/badge',
  '@/components/ui/button',
  '@/components/ui/dialog',
  '@/components/ui/input',
  '@/components/ui/label',
  '@/components/ui/native-select',
  '@/components/ui/popover',
]) {
  jest.mock(moduleName, () => ({}), { virtual: true });
}

describe('purchase inbound confirmation ui', () => {
  const page = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
    ),
    'utf8',
  );
  const inventoryPage = readFileSync(
    join(process.cwd(), 'client/src/pages/InventoryManagement/index.tsx'),
    'utf8',
  );
  const dialogPath = join(
    process.cwd(),
    'client/src/pages/InventoryManagement/PurchaseInboundConfirmationDialog.tsx',
  );

  function readDialog(): string {
    return readFileSync(dialogPath, 'utf8');
  }

  function createPendingPurchase(
    overrides: Partial<PurchasePendingInboundItem> = {},
  ): PurchasePendingInboundItem {
    return {
      executionRecordId: 'execution-1',
      submissionRecordId: 'submission-1',
      requestCode: 'CG-20260730-001',
      mode: null,
      sku: '',
      itemName: '温湿度传感器',
      specification: 'TH-100',
      brand: '测试品牌',
      primaryCategory: '仪器仪表',
      secondaryCategory: '环境监测',
      building: 'A楼',
      quantity: 2,
      unit: '台',
      signedAt: '2026-07-30T08:00:00.000Z',
      action: 'needs_selection',
      catalogRecordId: '',
      actionReason: '需要创建物品',
      ...overrides,
    };
  }

  function createExistingItem(
    overrides: Partial<InventoryMovementOptionItem> = {},
  ): InventoryMovementOptionItem {
    return {
      catalogRecordId: 'catalog-1',
      inventoryRecordId: 'inventory-1',
      sku: 'HJ001',
      name: '温湿度传感器',
      specification: 'TH-100',
      brand: '测试品牌',
      primaryCategory: '仪器仪表',
      secondaryCategory: '环境监测',
      building: 'B楼',
      location: 'B-01',
      unit: '台',
      availableQuantity: 8,
      ...overrides,
    };
  }

  function loadPureHelpers(): {
    createPurchaseInboundDraft: (
      item: PurchasePendingInboundItem,
      now?: Date,
    ) => Record<string, any>;
    validatePurchaseInboundDraft: (
      draft: Record<string, any>,
    ) => Record<string, string>;
    buildPurchaseInboundSubmission: (input: {
      item: PurchasePendingInboundItem;
      draft: Record<string, any>;
      clientMutationId: string;
      startedAt: number;
    }) => Record<string, any>;
    buildPurchaseInboundCategoryPrepareRequest: (input: {
      draft: Record<string, any>;
      clientMutationId: string;
    }) => Record<string, any>;
    recoverPurchaseInboundCategoryDraftAfterFailure: (
      draft: Record<string, any>,
      error: unknown,
    ) => Record<string, any>;
    restorePurchaseInboundDraftFromCategoryTask: (
      draft: Record<string, any>,
      request: Record<string, any>,
    ) => Record<string, any>;
  } {
    return require('../../client/src/pages/InventoryManagement/PurchaseInboundConfirmationDialog');
  }

  it('提交保留弹窗打开时的责任代际，清单后台刷新不改写已编辑请求', () => {
    const { createPurchaseInboundDraft, buildPurchaseInboundSubmission } = loadPureHelpers();
    const item = createPendingPurchase({ responsibilityGeneration: 2 });
    const draft = { ...createPurchaseInboundDraft(item), mode: 'existing', selectedItem: createExistingItem({ building: 'A楼' }) };
    const submission = buildPurchaseInboundSubmission({ item: { ...item, responsibilityGeneration: 3 }, draft,
      clientMutationId: 'synthetic-generation-submit', startedAt: 1234 });
    expect(submission.request.responsibilityGeneration).toBe(2);
    expect(submission.draft.responsibilityGeneration).toBe(2);
  });

  it('shows purchase inbound work only on the inbound management page', () => {
    expect(page).toContain('待采购入库');
    expect(page).toContain("type === 'inbound'");
    expect(page).toContain('getPendingPurchaseInbounds');
    expect(page).toContain('PurchaseInboundConfirmationDialog');
  });

  it('supports existing category linking and new category creation', () => {
    const dialog = readDialog();

    expect(dialog).toContain('已有物品');
    expect(dialog).toContain('新增物品');
    expect(dialog).toContain('创建库存类别并入库');
    expect(dialog).toContain('确认后才会增加库存');
    expect(dialog).toContain('getInventoryMovementOptions');
    expect(dialog).toContain('preparePurchaseInboundCategory');
    expect(dialog).toContain('getPurchaseInboundCategoryTaskStatus');
    expect(dialog).toContain('createPurchaseInboundCategoryTaskCoordinator');
    expect(dialog).toContain('.resume(item.executionRecordId)');
    expect(dialog).toContain("window.addEventListener('focus'");
    expect(dialog).toContain("document.addEventListener('visibilitychange'");
    expect(dialog).toContain("categoryTaskPhase === 'accepted'");
    expect(dialog).toContain("categoryTaskPhase === 'syncing'");
    expect(dialog).toContain('后台生成中');
    expect(dialog).not.toContain('CATEGORY_TASK_MAX_POLL_ATTEMPTS');
    expect(dialog).toContain('生成新的物品类别号');
    expect(dialog).toContain('role="radiogroup"');
    expect(dialog).not.toContain('confirmPurchaseInbound');
    expect(dialog).toContain('minimumQuantity');
    for (const label of [
      '入库楼栋',
      '一级分类',
      '二级分类',
      '物品名称',
      '规格型号',
      '存放位置',
      '物品类别号',
    ]) {
      expect(dialog).toContain(label);
    }
    expect(dialog).not.toContain('value={newItem.sku}');
  });

  it('shows an unacknowledged category request as unresolved with a same-number retry', () => {
    const dialog = readDialog();

    expect(dialog).toMatch(
      /categoryTaskPhase === 'uncertain'\s*\?\s*'结果待核对'/u,
    );
    expect(dialog).toContain('使用原编号重试');
  });

  it('restores the accepted category task request without pretending it completed', () => {
    const {
      createPurchaseInboundDraft,
      restorePurchaseInboundDraftFromCategoryTask,
    } = loadPureHelpers();
    const draft = createPurchaseInboundDraft(createPendingPurchase());
    const request = {
      executionRecordId: 'execution-1',
      clientMutationId: 'category-mutation-1',
      building: draft.building,
      quantity: 2,
      occurredAt: '2026-09-15T01:00:00.000Z',
      newItem: {
        primaryCategory: 'primary',
        secondaryCategory: 'secondary',
        name: 'sensor',
        specification: 'TH-100',
        location: 'A-01',
        locationRecordId: 'location-1',
        brand: 'brand',
        unit: 'piece',
        minimumQuantity: 1,
      },
    };

    const restored = restorePurchaseInboundDraftFromCategoryTask(
      draft,
      request,
    );

    expect(restored).toMatchObject({
      executionRecordId: 'execution-1',
      clientMutationId: 'category-mutation-1',
      mode: 'new',
      quantity: '2',
      preparedCatalogRecordId: '',
      generatedSku: '',
      preparedAt: '',
      newItem: {
        primaryCategory: 'primary',
        secondaryCategory: 'secondary',
        name: 'sensor',
        specification: 'TH-100',
        location: 'A-01',
        locationRecordId: 'location-1',
        brand: 'brand',
        unit: 'piece',
        minimumQuantity: '1',
      },
    });
    expect(new Date(restored.occurredAt).toISOString()).toBe(
      request.occurredAt,
    );
  });

  it('creates a restorable draft from the purchase defaults', () => {
    const { createPurchaseInboundDraft } = loadPureHelpers();
    const item = createPendingPurchase();

    expect(
      createPurchaseInboundDraft(item, new Date('2026-07-30T09:15:00.000Z')),
    ).toEqual({
      kind: 'purchase',
      executionRecordId: 'execution-1',
      clientMutationId: undefined,
      mode: '',
      building: 'A楼',
      quantity: '2',
      occurredAt: '2026-07-30T17:15',
      itemQuery: '',
      selectedItem: null,
      preparedCatalogRecordId: '',
      generatedSku: '',
      preparedAt: '',
      newItem: {
        primaryCategory: '仪器仪表',
        secondaryCategory: '环境监测',
        name: '温湿度传感器',
        specification: 'TH-100',
        location: '',
        locationRecordId: '',
        brand: '测试品牌',
        unit: '台',
        minimumQuantity: '0',
      },
    });
  });

  it('restores a prepared category from the server pending snapshot', () => {
    const { createPurchaseInboundDraft } = loadPureHelpers();
    const item = createPendingPurchase({
      preparedCategory: {
        catalogRecordId: 'catalog-prepared-1',
        sku: 'HJ008',
        preparedAt: '2026-07-30T09:20:00.000Z',
        clientMutationId: 'prepare-mutation-1',
        building: 'H楼',
        quantity: 4,
        occurredAt: '2026-07-30T09:15:00.000Z',
        newItem: {
          primaryCategory: '仪器仪表',
          secondaryCategory: '环境监测',
          name: '温湿度传感器',
          specification: 'TH-200',
          location: 'H-02',
          brand: '测试品牌',
          unit: '台',
          minimumQuantity: 5,
        },
      },
    });

    expect(createPurchaseInboundDraft(item)).toMatchObject({
      executionRecordId: 'execution-1',
      clientMutationId: 'prepare-mutation-1',
      mode: 'new',
      building: 'H楼',
      quantity: '4',
      occurredAt: '2026-07-30T17:15',
      preparedCatalogRecordId: 'catalog-prepared-1',
      generatedSku: 'HJ008',
      preparedAt: '2026-07-30T09:20:00.000Z',
      newItem: {
        primaryCategory: '仪器仪表',
        secondaryCategory: '环境监测',
        name: '温湿度传感器',
        specification: 'TH-200',
        location: 'H-02',
        brand: '测试品牌',
        unit: '台',
        minimumQuantity: '5',
      },
    });
  });

  it('builds a strict existing request for the selected target building', () => {
    const { buildPurchaseInboundSubmission } = loadPureHelpers();
    const item = createPendingPurchase({
      mode: 'existing',
      action: 'needs_mapping',
      quantity: 3,
    });
    const selectedItem = createExistingItem({
      sku: ' HJ001 ',
      name: ' 温湿度传感器 ',
      specification: ' TH-100 ',
      location: ' B-01 ',
      unit: ' 台 ',
    });
    const draft = {
      kind: 'purchase',
      executionRecordId: 'execution-1',
      clientMutationId: undefined,
      mode: 'existing',
      building: 'B楼',
      quantity: '3',
      occurredAt: '2026-07-30T10:30',
      itemQuery: '传感器',
      selectedItem,
      newItem: {
        primaryCategory: '',
        secondaryCategory: '',
        name: '',
        specification: '',
        location: '',
        brand: '',
        unit: '',
        minimumQuantity: '0',
      },
    };
    const snapshot = structuredClone(draft);

    const submission = buildPurchaseInboundSubmission({
      item,
      draft,
      clientMutationId: 'purchase-mutation-existing',
      startedAt: 1234,
    });

    expect(submission.request).toEqual({
      executionRecordId: 'execution-1',
      building: 'B楼',
      clientMutationId: 'purchase-mutation-existing',
      mode: 'existing',
      catalogRecordId: 'catalog-1',
      sku: 'HJ001',
      quantity: 3,
      occurredAt: new Date('2026-07-30T10:30').toISOString(),
    });
    expect(submission.optimisticMovement).toEqual({
      recordId: 'pending:purchase-mutation-existing',
      clientMutationId: 'purchase-mutation-existing',
      pendingSync: true,
      type: 'inbound',
      sku: 'HJ001',
      name: '温湿度传感器',
      specification: 'TH-100',
      quantity: 3,
      unit: '台',
      building: 'B楼',
      destinationBuilding: '',
      location: 'B-01',
      reason: '采购入库 · CG-20260730-001',
      operator: '',
      applicant: '',
      status: '同步中',
      occurredAt: new Date('2026-07-30T10:30').toISOString(),
      expectedReturnAt: null,
      overdue: false,
    });
    expect(submission.purchaseExecutionRecordId).toBe('execution-1');
    expect(submission.clientMutationId).toBe('purchase-mutation-existing');
    expect(submission.startedAt).toBe(1234);
    expect(submission.draft).toEqual({
      ...snapshot,
      clientMutationId: 'purchase-mutation-existing',
    });
    expect(submission.draft).not.toBe(draft);
    expect(draft).toEqual(snapshot);
  });

  it('builds a strict new request with the prepared category number', () => {
    const { buildPurchaseInboundSubmission } = loadPureHelpers();
    const item = createPendingPurchase({ quantity: 4 });
    const draft = {
      kind: 'purchase',
      executionRecordId: 'execution-1',
      clientMutationId: 'old-id-is-replaced-by-explicit-id',
      mode: 'new',
      building: 'H楼',
      quantity: '4',
      occurredAt: '2026-07-30T11:45',
      itemQuery: 'unused',
      selectedItem: createExistingItem(),
      preparedCatalogRecordId: 'catalog-prepared-new',
      generatedSku: 'HJ009',
      preparedAt: '2026-07-30T11:50:00.000Z',
      newItem: {
        primaryCategory: ' 仪器仪表 ',
        secondaryCategory: ' 环境监测 ',
        name: ' 温湿度传感器 ',
        specification: ' TH-200 ',
        location: ' H-02 ',
        brand: ' 测试品牌 ',
        unit: ' 台 ',
        minimumQuantity: ' 5 ',
      },
    };

    const submission = buildPurchaseInboundSubmission({
      item,
      draft,
      clientMutationId: 'purchase-mutation-new',
      startedAt: 5678,
    });

    expect(submission.request).toEqual({
      executionRecordId: 'execution-1',
      building: 'H楼',
      clientMutationId: 'purchase-mutation-new',
      mode: 'new',
      preparedCatalogRecordId: 'catalog-prepared-new',
      generatedSku: 'HJ009',
      quantity: 4,
      occurredAt: new Date('2026-07-30T11:45').toISOString(),
      newItem: {
        primaryCategory: '仪器仪表',
        secondaryCategory: '环境监测',
        name: '温湿度传感器',
        specification: 'TH-200',
        location: 'H-02',
        brand: '测试品牌',
        unit: '台',
        minimumQuantity: 5,
      },
    });
    expect(submission.request).not.toHaveProperty('sku');
    expect(submission.request).not.toHaveProperty('catalogRecordId');
    expect(submission.optimisticMovement).toMatchObject({
      recordId: 'pending:purchase-mutation-new',
      sku: 'HJ009',
      name: '温湿度传感器',
      specification: 'TH-200',
      quantity: 4,
      unit: '台',
      building: 'H楼',
      location: 'H-02',
      pendingSync: true,
      status: '同步中',
    });
    expect(submission.draft.clientMutationId).toBe('purchase-mutation-new');
  });

  it('builds category preparation from the editable purchase fields', () => {
    const { buildPurchaseInboundCategoryPrepareRequest } = loadPureHelpers();
    const request = buildPurchaseInboundCategoryPrepareRequest({
      clientMutationId: 'prepare-new-category-1',
      draft: {
        kind: 'purchase',
        executionRecordId: 'execution-1',
        mode: 'new',
        building: 'E楼',
        quantity: '2',
        occurredAt: '2026-07-30T11:45',
        itemQuery: '',
        selectedItem: null,
        preparedCatalogRecordId: '',
        generatedSku: '',
        preparedAt: '',
        newItem: {
          primaryCategory: ' 仪器仪表 ',
          secondaryCategory: ' 环境监测 ',
          name: ' 温湿度传感器 ',
          specification: ' TH-200 ',
          location: ' E-02 ',
          locationRecordId: ' rec-location-e-02 ',
          brand: ' 测试品牌 ',
          unit: ' 台 ',
          minimumQuantity: ' 5 ',
        },
      },
    });

    expect(request).toEqual({
      executionRecordId: 'execution-1',
      clientMutationId: 'prepare-new-category-1',
      building: 'E楼',
      quantity: 2,
      occurredAt: new Date('2026-07-30T11:45').toISOString(),
      newItem: {
        primaryCategory: '仪器仪表',
        secondaryCategory: '环境监测',
        name: '温湿度传感器',
        specification: 'TH-200',
        location: 'E-02',
        locationRecordId: 'rec-location-e-02',
        brand: '测试品牌',
        unit: '台',
        minimumQuantity: 5,
      },
    });
  });

  it('validates target-building inventory data and all five required new-item fields', () => {
    const { validatePurchaseInboundDraft } = loadPureHelpers();
    const base = {
      kind: 'purchase',
      executionRecordId: 'execution-1',
      clientMutationId: undefined,
      building: 'B楼',
      quantity: '1',
      occurredAt: '2026-07-30T10:30',
      itemQuery: '',
      selectedItem: null,
      newItem: {
        primaryCategory: '',
        secondaryCategory: '',
        name: '',
        specification: '',
        location: '',
        brand: '',
        unit: '',
        minimumQuantity: '0',
      },
    };

    expect(validatePurchaseInboundDraft({ ...base, mode: '' })).toMatchObject({
      mode: '请选择入库类型',
    });

    expect(
      validatePurchaseInboundDraft({ ...base, mode: 'new' }),
    ).toMatchObject({
      primaryCategory: '请填写一级分类',
      secondaryCategory: '请填写二级分类',
      name: '请填写物品名称',
      specification: '请填写规格型号',
      location: '请填写存放位置',
    });
    expect(
      validatePurchaseInboundDraft({
        ...base,
        mode: 'new',
        newItem: {
          primaryCategory: '仪器仪表',
          secondaryCategory: '环境监测',
          name: '温湿度传感器',
          specification: 'TH-200',
          location: 'B-02',
          brand: '',
          unit: '台',
          minimumQuantity: '0',
        },
      }),
    ).toMatchObject({
      generatedSku: '请先生成新的物品类别号',
    });
    expect(
      validatePurchaseInboundDraft({
        ...base,
        mode: 'existing',
        selectedItem: createExistingItem({ building: 'A楼' }),
      }),
    ).toMatchObject({ catalog: '请选择当前入库楼栋的物品' });
    expect(
      validatePurchaseInboundDraft({
        ...base,
        mode: 'existing',
        selectedItem: createExistingItem({
          inventoryRecordId: '',
          location: '',
        }),
      }),
    ).toMatchObject({
      catalog: '所选物品未配置库存库位，请先配置库位',
    });
  });

  it('keeps retry mutation ids only until a business field is edited', () => {
    const dialog = readDialog();

    expect(dialog).toContain('initialDraft?: PurchaseInboundDraft');
    expect(dialog).toContain('cloneDraft(initialDraft)');
    expect(dialog).toContain('draft!.clientMutationId?.trim()');
    expect(dialog).toContain('clearRetryMutationId');
    expect(dialog).toContain('clientMutationId: mutationId');
    expect(dialog).toContain('inboundSubmitGuard.current');
    expect(dialog).toContain('onSubmit(submission)');
    expect(dialog).not.toContain('await onSubmit');
  });

  it('prefers an editable retry draft over a prepared pending snapshot', () => {
    const dialog = readDialog();

    expect(dialog).toContain(
      'initialDraft?.executionRecordId === item.executionRecordId',
    );
    expect(dialog).not.toContain(
      '!item.preparedCategory &&\n      initialDraft?.executionRecordId === item.executionRecordId',
    );
  });

  it('releases a category mutation id after a definite 409 rejection', () => {
    const { recoverPurchaseInboundCategoryDraftAfterFailure } =
      loadPureHelpers();
    const draft = {
      kind: 'purchase',
      executionRecordId: 'execution-1',
      clientMutationId: 'occupied-category-mutation',
    };

    expect(
      recoverPurchaseInboundCategoryDraftAfterFailure(draft, {
        response: {
          status: 409,
          data: {
            message: 'clientMutationId 已被不同的物品类别号请求占用',
          },
        },
      }).clientMutationId,
    ).toBeUndefined();
  });

  it('keeps a category mutation id when the response outcome is unknown', () => {
    const { recoverPurchaseInboundCategoryDraftAfterFailure } =
      loadPureHelpers();
    const draft = {
      kind: 'purchase',
      executionRecordId: 'execution-1',
      clientMutationId: 'uncertain-category-mutation',
    };

    expect(
      recoverPurchaseInboundCategoryDraftAfterFailure(
        draft,
        Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }),
      ).clientMutationId,
    ).toBe('uncertain-category-mutation');
  });

  it('locks recovered purchase fields and restores from a bounded pending-item snapshot', () => {
    const dialog = readDialog();

    expect(dialog).toContain('retryLocked?: boolean');
    expect(dialog).toContain('<fieldset');
    expect(dialog).toContain(
      'disabled={retryLocked || categoryTaskActive || preparedNew}',
    );
    expect(dialog).toContain('恢复草稿已锁定');
    expect(page).toContain('createPurchaseInboundRecoveryDraft');
    expect(page).toContain('isPurchaseInboundRecoveryDraft');
    expect(page).toContain('purchaseSnapshot');
    expect(page).toContain(
      'retryLocked={Boolean(purchaseRetryDraft?.clientMutationId)}',
    );
    expect(page).not.toContain(
      'clearInventoryInboundRecovery(recovery.clientMutationId);',
    );
  });

  it('does not automatically reopen a recovery draft dismissed by the user', () => {
    expect(page).toContain('dismissedInboundRecoveryMutationIdRef');
    expect(page).toMatch(
      /recovery\.clientMutationId\s*===\s*dismissedInboundRecoveryMutationIdRef\.current/,
    );
    expect(page).toContain('handlePurchaseInboundOpenChange');
  });

  it('offers an explicit way to abandon an outcome-unknown retry id', () => {
    const dialog = readDialog();

    expect(dialog).toContain('onAbandonRetry?: () => void');
    expect(dialog).toContain('放弃原编号并编辑');
    expect(page).toContain('onAbandonRetry={abandonPurchaseInboundRetry}');
  });

  it('queries an accepted recovery once instead of reopening its submission dialog', () => {
    const handlerStart = page.indexOf(
      'const handlePendingPurchaseAction = (item: PurchasePendingInboundItem) => {',
    );
    const handlerEnd = page.indexOf(
      '\n  const canDeleteMovement = useCallback',
      handlerStart,
    );
    const handler = page.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain("recovery.status === 'accepted'");
    expect(handler).toContain('queryAcceptedPurchaseInboundRecovery(recovery)');
    expect(handler.indexOf("recovery.status === 'accepted'")).toBeLessThan(
      handler.indexOf('applyInboundRecovery(recovery)'),
    );
  });

  it('never silently ignores a purchase retry while the same mutation is active', () => {
    const submitStart = page.indexOf(
      'const submitPurchaseInbound = useCallback',
    );
    const submitEnd = page.indexOf(
      '\n  const handlePurchaseCategoryPrepared = useCallback',
      submitStart,
    );
    const submit = page.slice(submitStart, submitEnd);
    const activeGuardStart = submit.indexOf(
      'activeInboundMutationIdsRef.current.has(submission.clientMutationId)',
    );
    const activeGuardEnd = submit.indexOf('const retryItem', activeGuardStart);
    const activeGuard = submit.slice(activeGuardStart, activeGuardEnd);

    expect(activeGuardStart).toBeGreaterThanOrEqual(0);
    expect(activeGuardEnd).toBeGreaterThan(activeGuardStart);
    expect(activeGuard).toContain('toast.info(');
    expect(activeGuard).toContain('后台同步');
  });

  it('keeps an outcome-unknown recovery on the original mutation id', () => {
    expect(page).toMatch(
      /recovery\.status !== 'accepted'[\s\S]{0,1200}applyInboundRecovery\(recovery\)/,
    );
    expect(readDialog()).toContain(
      'draft!.clientMutationId?.trim() || createClientMutationId()',
    );
  });

  it('rejects canonical success records that belong to another request', () => {
    expect(page).toContain('result.recordId !== movement.recordId');
    expect(page).toContain(
      'result.executionRecordId !== submission.purchaseExecutionRecordId',
    );
    expect(page).toContain('result.inboundRecordId !== movement.recordId');
    expect(page).toContain(
      'movement.clientMutationId !== expectation.clientMutationId',
    );
    expect(page).toContain('movement.building !== expectation.building');
    expect(page).toContain('movement.quantity !== expectation.quantity');
    expect(page).toContain('submission.request.generatedSku');
    expect(page).toContain('submission.request.preparedCatalogRecordId');
  });

  it('keeps a generated category in the local pending item after closing the dialog', () => {
    expect(page).toContain('handlePurchaseCategoryPrepared');
    expect(page).toContain(
      'onCategoryPrepared={handlePurchaseCategoryPrepared}',
    );
    expect(page).toContain('preparedCategory: clonePreparedCategory');
    expect(page).toContain('setSelectedPending((current) =>');
  });

  it('searches existing stock in the selected target building and invalidates stale searches', () => {
    const dialog = readDialog();

    expect(dialog).toContain('building: draft.building');
    expect(dialog).toContain('searchSequence.current');
    expect(dialog).toContain('changeBuilding');
    expect(dialog).toContain("itemQuery: ''");
    expect(dialog).toContain('selectedItem: null');
    expect(dialog).toContain('setOptions([])');
  });

  it('opens one manual-type confirmation dialog for every pending purchase', () => {
    expect(page).toContain('采购完成入库');
    expect(page).not.toContain('其他入库');
    expect(page).toContain('confirmPurchaseInbound');
    expect(page).toContain('handlePendingPurchaseAction');
    expect(page).toContain('setSelectedPending(item)');
    expect(page).toContain('办理入库');
    expect(page).toContain('待选择');
    expect(page).toContain('新增（已生成）');
    expect(page).not.toContain('关联后入库');
    expect(page).not.toContain('建类后入库');
  });

  it('keeps unrelated pending-purchase actions out of the active row spinner', () => {
    const actionButtonStart = page.indexOf(
      'function PendingPurchaseActionButton(',
    );
    const actionButtonEnd = page.indexOf(
      '\nfunction SummaryCard(',
      actionButtonStart,
    );
    const actionButton = page.slice(actionButtonStart, actionButtonEnd);

    expect(actionButtonStart).toBeGreaterThanOrEqual(0);
    expect(actionButton).toContain('isConfirming');
    expect(actionButton).not.toContain('inboundSyncing');
    expect(page).not.toContain('if (inboundSyncing) return;');
  });

  it('shows completion notification warnings after a successful inbound', () => {
    const warningToast =
      /notificationWarnings\.forEach\(\(warning\) =>\s*toast\.warning\(warning\),?\s*\)/;

    expect(page).toContain('Array.isArray(');
    expect(page).toContain("typeof warning === 'string'");
    expect(page).toMatch(warningToast);
    expect(readDialog()).not.toMatch(warningToast);
  });

  it('opens an exact pending purchase from the inbound deep link only once', () => {
    expect(inventoryPage).toMatch(
      /purchaseExecutionRecordId=\{\s*searchParams\.get\('purchase'\) \?\? undefined\s*\}/,
    );
    expect(page).toContain('purchaseExecutionRecordId?: string');
    expect(page).toContain('handledPurchaseDeepLinkRef');
    expect(page).toContain(
      'item.executionRecordId === normalizedPurchaseExecutionRecordId',
    );
    expect(page).toContain('targetPurchaseRef.current?.scrollIntoView');
    expect(page).toContain('data-purchase-execution-id');
    expect(page).toContain('ring-2 ring-emerald-300');
  });

  it('uses one cache-first deep-link pipeline and does not duplicate read errors', () => {
    expect(page).toMatch(
      /if \(type === 'inbound' && !normalizedPurchaseExecutionRecordId\)\s+void loadPendingPurchases\(\)/,
    );
    expect(page).toContain('resolvePendingPurchaseDeepLink(');
    expect(page).not.toContain('指定的待入库采购读取失败');
  });

  it('retries a failed deep link through the same resolver without reloading the page', () => {
    expect(page).toContain('const retryPendingPurchases = useCallback(');
    expect(page).toMatch(
      /retryPendingPurchases[\s\S]*?openPendingPurchaseDeepLink\(\)/,
    );
    expect(page).toContain('onClick={retryPendingPurchases}');
  });

  it('reports an unavailable deep-linked purchase without selecting a fallback', () => {
    expect(page).toContain('未找到指定的待入库采购');
    expect(page).toContain('可能已完成入库，或当前账号无权查看');
    expect(page).not.toContain('pendingPurchases[0]');
  });

  it('renders pending purchases as a responsive paginated list', () => {
    const pendingListStart = page.search(
      /(?:^|\n)function PendingPurchaseRecords\(/,
    );
    const summaryCardStart = page.indexOf('function SummaryCard');

    expect(pendingListStart).toBeGreaterThan(-1);
    expect(summaryCardStart).toBeGreaterThan(pendingListStart);
    const pendingListSource = page.slice(pendingListStart, summaryCardStart);
    const pendingTableHead = pendingListSource.match(
      /<thead[\s\S]*?<\/thead>/,
    )?.[0];
    const pendingHeaders = [
      '物品 / 类别号',
      '采购单 / 楼栋',
      '规格 / 品牌',
      '类型 / 待处理事项',
      '实收数量',
      '签收时间',
      '操作',
    ];

    expect(page).toContain('const PENDING_PAGE_SIZE = 20');
    expect(page).toMatch(
      /const visiblePendingPurchases\s*=\s*filteredPendingPurchases\.slice\(\s*\(pendingPage\s*-\s*1\)\s*\*\s*PENDING_PAGE_SIZE\s*,\s*pendingPage\s*\*\s*PENDING_PAGE_SIZE\s*,?\s*\)/,
    );
    expect(pendingListSource).toMatch(
      /<table[\s\S]*?<caption[^>]*>\s*待采购入库清单\s*<\/caption>/,
    );
    expect(pendingListSource).toContain(
      'className="hidden overflow-x-auto md:block"',
    );
    expect(pendingListSource).toContain('className="grid gap-3 p-4 md:hidden"');
    expect(pendingTableHead).toBeDefined();
    expect(pendingTableHead?.match(/<th\b/g)).toHaveLength(
      pendingHeaders.length + 1,
    );
    expect(pendingTableHead).toContain('选择本页待入库物品');
    expect(pendingListSource).toContain('selectedIds.has(item.executionRecordId)');
    expect(pendingListSource).toContain('onToggleSelection(item.executionRecordId)');
    expect(page).toContain('批量办理入库');
    expect(page).toContain('stagePurchaseBatch');
    pendingHeaders.forEach((header) => {
      expect(pendingTableHead).toMatch(
        new RegExp(`<th\\b[^>]*>\\s*${header}\\s*</th>`),
      );
    });
    expect(pendingListSource).toContain('aria-label="待采购入库清单上一页"');
    expect(pendingListSource).toContain('aria-label="待采购入库清单下一页"');
    expect(page).not.toContain('lg:grid-cols-2');
  });
});
